import { audit, now, type Db } from "../core/db.js";
import { normalisePhone } from "../whatsapp/client.js";
import { qualify, extractPhone, type Signal } from "./scoring.js";

export type LeadRow = {
  id: number;
  source: string;
  source_ref: string | null;
  ig_username: string | null;
  phone: string | null;
  name: string | null;
  score: number;
  stage: string;
  consent: string;
  consent_source: string | null;
  consent_at: number | null;
  opted_out_at: number | null;
  last_inbound_at: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

export type CaptureInput = {
  source: string;
  sourceRef?: string;
  igUsername?: string;
  name?: string;
  text?: string;
  phone?: string;
  defaultCountryCode?: string;
  followsAccount?: boolean;
  repliedToDm?: boolean;
  occurredAt?: number;
};

/**
 * Capture, deduplicate and qualify a lead.
 *
 * Deduplication is by phone first, then by Instagram username. Two comments from the same
 * person on two posts are one lead with a higher score, not two leads who both get messaged.
 */
export function captureLead(db: Db, input: CaptureInput): { lead: LeadRow; created: boolean } {
  const timestamp = now();
  const rawPhone = input.phone ?? (input.text ? extractPhone(input.text) : null);
  const phone = rawPhone ? normalisePhone(rawPhone, input.defaultCountryCode) : null;

  const signal: Signal = {
    text: input.text,
    hasPhone: Boolean(phone),
    repliedToDm: input.repliedToDm,
    followsAccount: input.followsAccount,
    source: input.source,
    ageSeconds: input.occurredAt ? Math.max(0, timestamp - input.occurredAt) : 0,
  };
  const qualification = qualify(signal);

  const existing = findExisting(db, phone, input.igUsername);

  if (existing) {
    // Keep the best score the lead has ever earned: a later "🔥" comment must not undo an
    // earlier "what is your price".
    const score = Math.max(existing.score, qualification.score);
    const stage = existing.stage === "new" && score >= 40 ? "qualified" : existing.stage;

    db.prepare(
      "UPDATE leads SET score = ?, stage = ?, phone = COALESCE(phone, ?), name = COALESCE(name, ?), ig_username = COALESCE(ig_username, ?), notes = ?, updated_at = ? WHERE id = ?"
    ).run(
      score,
      stage,
      phone,
      input.name ?? null,
      input.igUsername ?? null,
      appendNote(existing.notes, input.text, qualification.reasons.map((r) => r.id)),
      timestamp,
      existing.id
    );

    audit(db, { actor: "system", action: "lead.updated", subject: String(existing.id), detail: qualification });
    return { lead: getLead(db, existing.id)!, created: false };
  }

  const result = db
    .prepare(
      "INSERT INTO leads (source, source_ref, ig_username, phone, name, score, stage, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
    .run(
      input.source,
      input.sourceRef ?? null,
      input.igUsername ?? null,
      phone,
      input.name ?? null,
      qualification.score,
      qualification.qualified ? "qualified" : "new",
      appendNote(null, input.text, qualification.reasons.map((r) => r.id)),
      timestamp,
      timestamp
    );

  const lead = getLead(db, Number(result.lastInsertRowid))!;
  audit(db, { actor: "system", action: "lead.captured", subject: String(lead.id), detail: qualification });
  return { lead, created: true };
}

function findExisting(db: Db, phone: string | null, igUsername?: string): LeadRow | undefined {
  if (phone) {
    const byPhone = db.prepare("SELECT * FROM leads WHERE phone = ?").get(phone) as LeadRow | undefined;
    if (byPhone) return byPhone;
  }
  if (igUsername) {
    return db.prepare("SELECT * FROM leads WHERE ig_username = ? COLLATE NOCASE").get(igUsername) as LeadRow | undefined;
  }
  return undefined;
}

export function getLead(db: Db, id: number): LeadRow | undefined {
  return db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as LeadRow | undefined;
}

export function getLeadByPhone(db: Db, phone: string): LeadRow | undefined {
  return db.prepare("SELECT * FROM leads WHERE phone = ?").get(phone) as LeadRow | undefined;
}

/**
 * Records consent. `explicit` requires the operator to say where it came from, because
 * "they commented on a post" is not consent to be messaged on WhatsApp and the difference
 * is the whole compliance story.
 */
export function recordConsent(
  db: Db,
  leadId: number,
  consent: "explicit" | "inbound_message",
  source: string
): void {
  db.prepare("UPDATE leads SET consent = ?, consent_source = ?, consent_at = ?, opted_out_at = NULL, updated_at = ? WHERE id = ?").run(
    consent,
    source,
    now(),
    now(),
    leadId
  );
  audit(db, { actor: "system", action: "lead.consent", subject: String(leadId), detail: { consent, source } });
}

export function recordOptOut(db: Db, leadId: number, reason: string): void {
  db.prepare("UPDATE leads SET opted_out_at = ?, stage = 'rejected', updated_at = ? WHERE id = ?").run(now(), now(), leadId);
  audit(db, { actor: "system", action: "lead.opt_out", subject: String(leadId), detail: { reason } });
}

export function recordInbound(db: Db, leadId: number, at: number = now()): void {
  db.prepare("UPDATE leads SET last_inbound_at = ?, updated_at = ? WHERE id = ?").run(at, now(), leadId);
}

export function setStage(db: Db, leadId: number, stage: string): void {
  db.prepare("UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?").run(stage, now(), leadId);
}

function appendNote(existing: string | null, text?: string, reasonIds: string[] = []): string {
  const entry = [text?.slice(0, 500), reasonIds.length ? `[${reasonIds.join(", ")}]` : ""]
    .filter(Boolean)
    .join(" ");
  if (!entry) return existing ?? "";
  return existing ? `${existing}\n${entry}` : entry;
}

/** True when this provider event has already been handled. Meta retries; we do not repeat. */
export function claimEvent(db: Db, providerId: string, kind: string): boolean {
  try {
    db.prepare("INSERT INTO processed_events (provider_id, kind, processed_at) VALUES (?,?,?)").run(providerId, kind, now());
    return true;
  } catch {
    return false; // UNIQUE violation: already processed
  }
}
