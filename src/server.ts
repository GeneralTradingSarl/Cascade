import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, type App } from "./app.js";
import { audit, now } from "./core/db.js";
import { verifySignature, verifySubscription } from "./webhooks/verify.js";
import { handleInstagramWebhook, handleWhatsAppWebhook } from "./webhooks/router.js";
import { captureLead, getLead, recordConsent, recordOptOut, setStage } from "./leads/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * HTTP surface.
 *
 * Two kinds of caller, two kinds of authentication:
 *  - Meta posts to /webhooks/*, authenticated by the app-secret signature on the raw body.
 *  - n8n calls /api/*, authenticated by a shared key header.
 * Nothing else is exposed, and the dashboard is a static page that talks to /api like n8n does.
 */
export function createServer(app: App): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    try {
      if (url.pathname === "/health") return json(res, 200, health(app));

      if (url.pathname.startsWith("/webhooks/")) return await webhooks(app, req, res, url);

      if (url.pathname.startsWith("/api/")) {
        if (!authorised(app, req)) return json(res, 401, { error: "unauthorised" });
        return await api(app, req, res, url);
      }

      return staticFile(res, url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit(app.db, { actor: "system", action: "http.error", subject: url.pathname, detail: message });
      return json(res, 500, { error: message });
    }
  });
}

function health(app: App) {
  const counts = (table: string, where = "") =>
    Number((app.db.prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).get() as { c: number }).c);

  return {
    status: "ok",
    at: now(),
    leads: counts("leads"),
    qualified: counts("leads", "WHERE stage = 'qualified'"),
    contacted: counts("leads", "WHERE stage = 'contacted'"),
    postsPublishedToday: counts("posts", `WHERE status = 'published' AND published_at >= ${now() - 86400}`),
    instagramQuotaRemaining: app.publisher.quotaRemaining(),
    jobsPending: counts("jobs", "WHERE status = 'pending'"),
    jobsDead: counts("jobs", "WHERE status = 'dead'"),
  };
}

async function webhooks(app: App, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const channel = url.pathname.split("/")[2];

  if (req.method === "GET") {
    const result = verifySubscription(url.searchParams, app.config.meta.verifyToken);
    if (!result.ok) return text(res, 403, result.reason);
    return text(res, 200, result.challenge);
  }

  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  const raw = await readRaw(req);
  if (!verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined, app.config.meta.appSecret)) {
    audit(app.db, { actor: "system", action: "webhook.bad_signature", subject: channel });
    return json(res, 403, { error: "bad signature" });
  }

  const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  const enqueue = (kind: string, payload: Record<string, unknown>) => {
    app.queue.enqueue(kind, payload);
  };

  const result =
    channel === "instagram"
      ? handleInstagramWebhook(app.db, body, enqueue)
      : handleWhatsAppWebhook(app.db, body, enqueue);

  // Meta wants a fast 200. The work is in the queue by now.
  json(res, 200, { received: result.handled });
  void app.queue.drain();
  return;
}

async function api(app: App, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const { db, queue } = app;
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/leads") {
    const stage = url.searchParams.get("stage");
    const minScore = Number(url.searchParams.get("minScore") ?? 0);
    const rows = db
      .prepare(
        `SELECT * FROM leads WHERE score >= ? ${stage ? "AND stage = ?" : ""} ORDER BY score DESC, updated_at DESC LIMIT 200`
      )
      .all(...(stage ? [minScore, stage] : [minScore]));
    return json(res, 200, { leads: rows });
  }

  if (route === "POST /api/leads") {
    const body = await readJson(req);
    const { lead, created } = captureLead(db, body as any);
    queue.enqueue("lead.route", { leadId: lead.id });
    return json(res, created ? 201 : 200, { lead, created });
  }

  const consentMatch = url.pathname.match(/^\/api\/leads\/(\d+)\/consent$/);
  if (req.method === "POST" && consentMatch) {
    const body = (await readJson(req)) as { source?: string; optOut?: boolean };
    const leadId = Number(consentMatch[1]);
    if (body.optOut) recordOptOut(db, leadId, body.source ?? "operator");
    else recordConsent(db, leadId, "explicit", body.source ?? "operator");
    return json(res, 200, { lead: getLead(db, leadId) });
  }

  const outreachMatch = url.pathname.match(/^\/api\/leads\/(\d+)\/outreach$/);
  if (req.method === "POST" && outreachMatch) {
    const body = (await readJson(req)) as Record<string, unknown>;
    const id = queue.enqueue("whatsapp.send", { leadId: Number(outreachMatch[1]), ...body });
    await queue.drain();
    return json(res, 202, { jobId: id });
  }

  if (route === "POST /api/posts") {
    const body = (await readJson(req)) as {
      idempotencyKey?: string;
      kind?: string;
      caption?: string;
      media?: string[];
      scheduledFor?: number;
      approved?: boolean;
    };
    if (!body.media?.length) return json(res, 400, { error: "media is required" });

    const key = body.idempotencyKey ?? `post-${Date.now()}`;
    const timestamp = now();
    db.prepare(
      "INSERT OR IGNORE INTO posts (idempotency_key, kind, caption, media, status, scheduled_for, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(key, body.kind ?? "image", body.caption ?? null, JSON.stringify(body.media), body.approved ? "approved" : "draft", body.scheduledFor ?? null, timestamp, timestamp);

    const post = db.prepare("SELECT * FROM posts WHERE idempotency_key = ?").get(key) as { id: number; status: string };
    if (body.approved) {
      queue.enqueue("instagram.publish", { postId: post.id }, { delaySeconds: body.scheduledFor ? Math.max(0, body.scheduledFor - timestamp) : 0 });
    }
    return json(res, 201, { post });
  }

  const approveMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/approve$/);
  if (req.method === "POST" && approveMatch) {
    const postId = Number(approveMatch[1]);
    setPostApproved(app, postId);
    return json(res, 202, { postId });
  }

  if (route === "GET /api/posts") {
    return json(res, 200, { posts: db.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT 100").all() });
  }

  if (route === "GET /api/messages") {
    return json(res, 200, {
      messages: db
        .prepare("SELECT m.*, l.ig_username, l.phone FROM messages m LEFT JOIN leads l ON l.id = m.lead_id ORDER BY m.created_at DESC LIMIT 100")
        .all(),
    });
  }

  if (route === "GET /api/audit") {
    return json(res, 200, { entries: db.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT 100").all() });
  }

  if (route === "GET /api/stats") return json(res, 200, health(app));

  return json(res, 404, { error: "not found" });
}

function setPostApproved(app: App, postId: number): void {
  app.db.prepare("UPDATE posts SET status = 'approved', updated_at = ? WHERE id = ?").run(now(), postId);
  const post = app.db.prepare("SELECT scheduled_for FROM posts WHERE id = ?").get(postId) as { scheduled_for: number | null };
  const delay = post?.scheduled_for ? Math.max(0, post.scheduled_for - now()) : 0;
  app.queue.enqueue("instagram.publish", { postId }, { delaySeconds: delay });
}

function authorised(app: App, req: http.IncomingMessage): boolean {
  const key = req.headers["x-cascade-key"];
  return typeof key === "string" && key.length > 0 && key === app.config.apiKey;
}

function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readRaw(req);
  return raw.length ? JSON.parse(raw.toString("utf8")) : {};
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
}

function staticFile(res: http.ServerResponse, pathname: string): void {
  const file = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const full = path.join(here, "..", "public", file);
  if (!full.startsWith(path.join(here, "..", "public")) || !fs.existsSync(full)) {
    return text(res, 404, "not found");
  }
  const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
  res.writeHead(200, { "content-type": types[path.extname(full)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(full));
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const app = createApp();
  app.queue.start();
  createServer(app).listen(app.config.port, () => {
    console.log(`cascade listening on ${app.config.publicUrl} (port ${app.config.port})`);
  });
}
