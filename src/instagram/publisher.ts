import type { GraphClient } from "../core/graph.js";
import { audit, now, type Db } from "../core/db.js";

/**
 * Instagram content publishing.
 *
 * The API is two-phase and the second phase is the one that bites:
 *
 *  1. Create a media container (`POST /{ig-user-id}/media`).
 *  2. Publish it (`POST /{ig-user-id}/media_publish`).
 *
 * Between the two, the container has a status. For an image it is usually FINISHED
 * immediately; for a reel, Instagram has to fetch and transcode the video, which takes
 * anywhere from seconds to minutes, and publishing an IN_PROGRESS container fails. So the
 * publisher polls `status_code` and only then publishes. Carousels need one child container
 * per item, created with `is_carousel_item=true`, then a parent container holding their ids.
 *
 * The account is also capped at 50 published posts per rolling 24 hours. That cap is checked
 * here rather than discovered as error 80007 halfway through a campaign.
 */
export type PostKind = "image" | "carousel" | "reel" | "story";

export type PublishRequest = {
  idempotencyKey: string;
  kind: PostKind;
  caption?: string;
  media: string[];
  coverUrl?: string;
};

export type ContainerStatus = { status_code: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED"; status?: string };

export class InstagramPublisher {
  constructor(
    private readonly graph: GraphClient,
    private readonly db: Db,
    private readonly accountId: string,
    private readonly dailyLimit: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  /** Posts published in the last rolling 24 hours. */
  publishedInLastDay(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM posts WHERE status = 'published' AND published_at >= ?")
      .get(now() - 86_400) as { count: number };
    return Number(row.count);
  }

  quotaRemaining(): number {
    return Math.max(0, this.dailyLimit - this.publishedInLastDay());
  }

  async publish(request: PublishRequest): Promise<{ mediaId: string; permalink?: string }> {
    const existing = this.db
      .prepare("SELECT id, status, media_id, permalink, container_id FROM posts WHERE idempotency_key = ?")
      .get(request.idempotencyKey) as
      | { id: number; status: string; media_id: string | null; permalink: string | null; container_id: string | null }
      | undefined;

    // A retry of an already-published post returns the original result rather than posting twice.
    if (existing?.status === "published" && existing.media_id) {
      return { mediaId: existing.media_id, permalink: existing.permalink ?? undefined };
    }

    if (this.quotaRemaining() <= 0) {
      throw Object.assign(new Error("Instagram daily publishing quota reached"), { retryable: true });
    }

    const postId = existing
      ? existing.id
      : this.insertPost(request);

    this.setStatus(postId, "publishing");

    try {
      const containerId = existing?.container_id ?? (await this.createContainer(request));
      this.db.prepare("UPDATE posts SET container_id = ?, updated_at = ? WHERE id = ?").run(containerId, now(), postId);

      await this.waitForContainer(containerId);

      const published = await this.graph.post<{ id: string }>(`${this.accountId}/media_publish`, {
        creation_id: containerId,
      });

      const permalink = await this.permalinkOf(published.id);
      this.db
        .prepare("UPDATE posts SET status = 'published', media_id = ?, permalink = ?, published_at = ?, updated_at = ?, error = NULL WHERE id = ?")
        .run(published.id, permalink ?? null, now(), now(), postId);
      audit(this.db, { actor: "system", action: "instagram.published", subject: request.idempotencyKey, detail: { mediaId: published.id } });

      return { mediaId: published.id, permalink: permalink ?? undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.prepare("UPDATE posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(message, now(), postId);
      throw error;
    }
  }

  private insertPost(request: PublishRequest): number {
    const timestamp = now();
    const result = this.db
      .prepare(
        "INSERT INTO posts (idempotency_key, kind, caption, media, status, created_at, updated_at) VALUES (?,?,?,?,'draft',?,?)"
      )
      .run(request.idempotencyKey, request.kind, request.caption ?? null, JSON.stringify(request.media), timestamp, timestamp);
    return Number(result.lastInsertRowid);
  }

  private setStatus(postId: number, status: string): void {
    this.db.prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), postId);
  }

  private async createContainer(request: PublishRequest): Promise<string> {
    const caption = request.caption ?? "";

    if (request.kind === "carousel") {
      const children: string[] = [];
      for (const url of request.media) {
        const child = await this.graph.post<{ id: string }>(`${this.accountId}/media`, {
          image_url: url,
          is_carousel_item: true,
        });
        children.push(child.id);
      }
      const parent = await this.graph.post<{ id: string }>(`${this.accountId}/media`, {
        media_type: "CAROUSEL",
        children: children.join(","),
        caption,
      });
      return parent.id;
    }

    const [first] = request.media;
    if (!first) throw Object.assign(new Error("no media supplied"), { retryable: false });

    if (request.kind === "reel") {
      const container = await this.graph.post<{ id: string }>(`${this.accountId}/media`, {
        media_type: "REELS",
        video_url: first,
        caption,
        ...(request.coverUrl ? { cover_url: request.coverUrl } : {}),
      });
      return container.id;
    }

    if (request.kind === "story") {
      const container = await this.graph.post<{ id: string }>(`${this.accountId}/media`, {
        media_type: "STORIES",
        image_url: first,
      });
      return container.id;
    }

    const container = await this.graph.post<{ id: string }>(`${this.accountId}/media`, {
      image_url: first,
      caption,
    });
    return container.id;
  }

  /** Polls until the container is ready. Reels are the reason this exists. */
  async waitForContainer(containerId: string, attempts = 20, intervalMs = 3000): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const status = await this.graph.get<ContainerStatus>(containerId, { fields: "status_code,status" });

      if (status.status_code === "FINISHED") return;
      if (status.status_code === "PUBLISHED") return;
      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
        throw Object.assign(new Error(`container ${containerId} is ${status.status_code}: ${status.status ?? ""}`), {
          retryable: false,
        });
      }
      await this.sleep(intervalMs);
    }
    // Still transcoding: retryable, the container stays valid for 24 hours.
    throw Object.assign(new Error(`container ${containerId} still processing after ${attempts} checks`), {
      retryable: true,
    });
  }

  private async permalinkOf(mediaId: string): Promise<string | undefined> {
    try {
      const media = await this.graph.get<{ permalink?: string }>(mediaId, { fields: "permalink" });
      return media.permalink;
    } catch {
      // A missing permalink is cosmetic; never fail a successful publish over it.
      return undefined;
    }
  }
}
