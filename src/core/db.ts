import { DatabaseSync } from "node:sqlite";

/**
 * Schema.
 *
 * Three things it is built around:
 *
 *  1. **Consent is a first-class column, not a flag buried in a JSON blob.** Sending a
 *     WhatsApp message to somebody who never opted in is how a business number gets its
 *     quality rating destroyed and eventually blocked, so the permission and where it came
 *     from are stored next to the phone number and checked on every send.
 *  2. **Every external event is deduplicated by its provider id.** Meta retries webhook
 *     deliveries, sometimes for hours. Processing a comment twice means DMing a lead twice.
 *  3. **Outbound messages are rows before they are requests.** A row is written, then sent,
 *     then updated with the provider id and the delivery status that arrives later by
 *     webhook. A crash mid-send leaves evidence instead of a mystery.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT NOT NULL,              -- instagram_comment | instagram_dm | form | manual
  source_ref        TEXT,                       -- comment id, thread id, form submission id
  ig_username       TEXT,
  phone             TEXT UNIQUE,                -- E.164, null until the lead gives it
  name              TEXT,
  score             INTEGER NOT NULL DEFAULT 0,
  stage             TEXT NOT NULL DEFAULT 'new',-- new | qualified | contacted | replied | won | lost | rejected
  consent           TEXT NOT NULL DEFAULT 'none', -- none | explicit | inbound_message
  consent_source    TEXT,
  consent_at        INTEGER,
  opted_out_at      INTEGER,
  last_inbound_at   INTEGER,                    -- drives the 24 hour service window
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_stage ON leads (stage);
CREATE INDEX IF NOT EXISTS leads_score ON leads (score DESC);

CREATE TABLE IF NOT EXISTS posts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key   TEXT UNIQUE NOT NULL,
  kind              TEXT NOT NULL,              -- image | carousel | reel | story
  caption           TEXT,
  media             TEXT NOT NULL,              -- JSON array of media urls
  status            TEXT NOT NULL DEFAULT 'draft', -- draft | approved | publishing | published | failed
  container_id      TEXT,
  media_id          TEXT,
  permalink         TEXT,
  scheduled_for     INTEGER,
  published_at      INTEGER,
  error             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_status ON posts (status, scheduled_for);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id           INTEGER REFERENCES leads(id),
  channel           TEXT NOT NULL,              -- whatsapp | instagram
  direction         TEXT NOT NULL,              -- in | out
  provider_id       TEXT UNIQUE,                -- wamid / ig message id
  body              TEXT,
  template          TEXT,
  status            TEXT NOT NULL DEFAULT 'queued', -- queued | sent | delivered | read | failed
  error             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_lead ON messages (lead_id, created_at);

CREATE TABLE IF NOT EXISTS processed_events (
  provider_id       TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  processed_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL,
  payload           TEXT NOT NULL,
  run_at            INTEGER NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | dead
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_runnable ON jobs (status, run_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                INTEGER NOT NULL,
  actor             TEXT NOT NULL,              -- system | n8n | operator
  action            TEXT NOT NULL,
  subject           TEXT,
  detail            TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log (at DESC);
`;

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Appends to the audit log. Every consent change and every outbound send goes through here. */
export function audit(
  db: Db,
  entry: { actor: string; action: string; subject?: string; detail?: unknown }
): void {
  db.prepare("INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?,?,?,?,?)").run(
    now(),
    entry.actor,
    entry.action,
    entry.subject ?? null,
    entry.detail === undefined ? null : JSON.stringify(entry.detail)
  );
}
