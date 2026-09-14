import { audit, now, type Db } from "../core/db.js";
import { getLead, recordOptOut, setStage } from "../leads/store.js";
import { decideSend } from "./session.js";
import type { WhatsAppClient } from "./client.js";

/**
 * The only place in the system that sends a WhatsApp message.
 *
 * Everything else asks this function. That is deliberate: consent, the service window, the
 * opt-out list and the audit trail are checked once, here, so no new workflow can bypass
 * them by calling the API client directly.
 */
export type OutreachRequest = {
  leadId: number;
  body?: string;
  template?: string;
  templateLanguage?: string;
  templateParameters?: string[];
};

export type OutreachResult =
  | { sent: true; mode: "freeform" | "template"; providerId?: string; reason: string }
  | { sent: false; reason: string };

export async function sendToLead(
  db: Db,
  client: WhatsAppClient,
  request: OutreachRequest,
  defaults: { template: string; language: string }
): Promise<OutreachResult> {
  const lead = getLead(db, request.leadId);
  if (!lead) return { sent: false, reason: "lead not found" };
  if (!lead.phone) return { sent: false, reason: "lead has no phone number" };

  const decision = decideSend({
    lastInboundAt: lead.last_inbound_at,
    consent: lead.consent,
    optedOutAt: lead.opted_out_at,
  });

  if (!decision.allowed) {
    audit(db, { actor: "system", action: "whatsapp.blocked", subject: String(lead.id), detail: decision });
    return { sent: false, reason: decision.reason };
  }

  const messageId = insertMessage(db, lead.id, decision.mode === "template" ? request.template ?? defaults.template : null, request.body ?? null);

  try {
    const result =
      decision.mode === "freeform" && request.body
        ? await client.sendText(lead.phone, request.body)
        : await client.sendTemplate(
            lead.phone,
            request.template ?? defaults.template,
            request.templateLanguage ?? defaults.language,
            (request.templateParameters ?? []).map((text) => ({ type: "text" as const, text }))
          );

    const providerId = result.messages?.[0]?.id;
    db.prepare("UPDATE messages SET status = 'sent', provider_id = ?, updated_at = ? WHERE id = ?").run(
      providerId ?? null,
      now(),
      messageId
    );
    if (lead.stage === "qualified" || lead.stage === "new") setStage(db, lead.id, "contacted");

    audit(db, { actor: "system", action: "whatsapp.sent", subject: String(lead.id), detail: { mode: decision.mode, providerId } });
    return { sent: true, mode: decision.mode, providerId, reason: decision.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(message, now(), messageId);

    // 131047 is "message outside the 24 hour window". If it appears, the window state we
    // hold is wrong, so the lead is marked as needing a template next time rather than
    // being retried into the same rejection.
    if (message.includes("131047")) {
      db.prepare("UPDATE leads SET last_inbound_at = NULL, updated_at = ? WHERE id = ?").run(now(), lead.id);
    }
    // 131026 / 131049: the recipient cannot receive, or delivery was suppressed for quality.
    if (message.includes("131026")) {
      recordOptOut(db, lead.id, "recipient unreachable on WhatsApp");
    }
    throw error;
  }
}

function insertMessage(db: Db, leadId: number, template: string | null, body: string | null): number {
  const timestamp = now();
  const result = db
    .prepare(
      "INSERT INTO messages (lead_id, channel, direction, body, template, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    )
    .run(leadId, "whatsapp", "out", body, template, "queued", timestamp, timestamp);
  return Number(result.lastInsertRowid);
}
