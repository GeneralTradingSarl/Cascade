import { audit, now, type Db } from "./db.js";
import { backoffMs } from "./graph.js";

/**
 * Durable job queue on SQLite.
 *
 * Why not just let n8n retry: n8n retries the whole workflow node, which for "publish to
 * Instagram" means creating a second media container and, if the first one actually
 * succeeded, publishing the same post twice. Work that touches an external account is
 * queued here instead, with the idempotency key carried in the payload, so a retry resumes
 * rather than restarts.
 */
export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

export type JobRow = {
  id: number;
  kind: string;
  payload: string;
  attempts: number;
  max_attempts: number;
};

export class JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly db: Db) {}

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  enqueue(kind: string, payload: Record<string, unknown>, options: { delaySeconds?: number; maxAttempts?: number } = {}): number {
    const timestamp = now();
    const result = this.db
      .prepare(
        "INSERT INTO jobs (kind, payload, run_at, max_attempts, created_at, updated_at) VALUES (?,?,?,?,?,?)"
      )
      .run(
        kind,
        JSON.stringify(payload),
        timestamp + (options.delaySeconds ?? 0),
        options.maxAttempts ?? 5,
        timestamp,
        timestamp
      );
    return Number(result.lastInsertRowid);
  }

  /** Runs every job that is due. Returns how many were attempted. */
  async drain(): Promise<number> {
    const due = this.db
      .prepare("SELECT id, kind, payload, attempts, max_attempts FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 25")
      .all(now()) as unknown as JobRow[];

    for (const job of due) {
      await this.run(job);
    }
    return due.length;
  }

  private async run(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      this.fail(job, `no handler registered for "${job.kind}"`, true);
      return;
    }

    this.db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now(), job.id);

    try {
      await handler(JSON.parse(job.payload) as Record<string, unknown>);
      this.db.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?").run(now(), job.id);
    } catch (error) {
      const retryable = (error as { retryable?: boolean }).retryable !== false;
      const attempts = job.attempts + 1;
      const exhausted = attempts >= job.max_attempts;
      this.fail(job, error instanceof Error ? error.message : String(error), !retryable || exhausted, attempts);
    }
  }

  private fail(job: JobRow, message: string, dead: boolean, attempts = job.attempts + 1): void {
    if (dead) {
      // Dead letters stay in the table on purpose: an operator needs to see what stopped,
      // and a queue that deletes its failures is a queue that loses leads quietly.
      this.db.prepare("UPDATE jobs SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ?").run(message, now(), job.id);
      audit(this.db, { actor: "system", action: "job.dead", subject: job.kind, detail: { id: job.id, message } });
      return;
    }
    const delay = Math.round(backoffMs(attempts) / 1000);
    this.db
      .prepare("UPDATE jobs SET status = 'pending', run_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(now() + Math.max(delay, 1), message, now(), job.id);
  }

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.drain().catch((error) => {
        audit(this.db, { actor: "system", action: "queue.error", detail: String(error) });
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
