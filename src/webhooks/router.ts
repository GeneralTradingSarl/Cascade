import { audit, now, type Db } from "../core/db.js";
import { captureLead, claimEvent, getLeadByPhone, recordConsent, recordInbound, recordOptOut } from "../leads/store.js";
import { isOptOut } from "../whatsapp/session.js";

/**
 * Webhook payload handling for Instagram and WhatsApp.
 *
 * Both products post to the same endpoint shape (`entry[].changes[]` for Instagram,
 * `entry[].changes[].value.messages[]` for WhatsApp) and both retry aggressively. Every
 * handler is therefore idempotent on the provider's own id, and every handler returns
 * quickly: Meta expects a 200 within seconds, so real work is queued, not done inline.
 */
export type Enqueue = (kind: string, payload: Record<string, unknown>) => void;

export type InstagramChange = {
  field: string;
  value: Record<string, any>;
};

export function handleInstagramWebhook(db: Db, body: any, enqueue: Enqueue): { handled: number } {
  let handled = 0;

  for (const entry of body?.entry ?? []) {
    for (const change of (entry.changes ?? []) as InstagramChange[]) {
      if (change.field === "comments") {
        const value = change.value;
        const commentId = String(value.id ?? "");
        if (!commentId || !claimEvent(db, commentId, "ig_comment")) continue;

        const { lead } = captureLead(db, {
          source: "instagram_comment",
          sourceRef: commentId,
          igUsername: value.from?.username,
          text: value.text,
          occurredAt: Number(value.timestamp ?? now()),
        });

        handled++;
        if (lead.stage === "qualified") {
          // A public comment is an intent signal, never consent to a WhatsApp message.
          // The DM asks for that consent explicitly.
          enqueue("instagram.reply_dm", { leadId: lead.id, commentId });
        }
      }

      if (change.field === "messages" || change.field === "messaging") {
        const value = change.value;
        const messageId = String(value.message?.mid ?? value.id ?? "");
        if (!messageId || !claimEvent(db, messageId, "ig_message")) continue;

        const { lead } = captureLead(db, {
          source: "instagram_dm",
          sourceRef: messageId,
          igUsername: value.from?.username ?? value.sender?.id,
          text: value.message?.text ?? value.text,
          repliedToDm: true,
          occurredAt: Number(value.timestamp ?? now()),
        });
        handled++;
        enqueue("lead.route", { leadId: lead.id });
      }
    }
  }

  return { handled };
}

export type WhatsAppInbound = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
};

export function handleWhatsAppWebhook(db: Db, body: any, enqueue: Enqueue): { handled: number } {
  let handled = 0;

  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      for (const message of (value.messages ?? []) as WhatsAppInbound[]) {
        if (!claimEvent(db, message.id, "wa_message")) continue;
        handled++;

        const at = Number(message.timestamp ?? now());
        const text = message.text?.body ?? "";
        const contactName = value.contacts?.[0]?.profile?.name;

        const existing = getLeadByPhone(db, message.from);
        const leadId = existing
          ? existing.id
          : captureLead(db, {
              source: "whatsapp_inbound",
              sourceRef: message.id,
              phone: message.from,
              name: contactName,
              text,
              occurredAt: at,
            }).lead.id;

        db.prepare(
          "INSERT OR IGNORE INTO messages (lead_id, channel, direction, provider_id, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
        ).run(leadId, "whatsapp", "in", message.id, text, "delivered", at, now());

        if (isOptOut(text)) {
          recordOptOut(db, leadId, `contact wrote: ${text.slice(0, 80)}`);
          enqueue("whatsapp.confirm_opt_out", { leadId });
          continue;
        }

        // Writing to the business opens the 24 hour window and counts as consent to reply
        // to this conversation, which is a weaker permission than a marketing opt-in.
        recordInbound(db, leadId, at);
        if (!existing || existing.consent === "none") {
          recordConsent(db, leadId, "inbound_message", "inbound WhatsApp message");
        }
        enqueue("whatsapp.handle_inbound", { leadId, messageId: message.id, text });
      }

      for (const status of (value.statuses ?? []) as { id: string; status: string; errors?: any[] }[]) {
        db.prepare("UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE provider_id = ?").run(
          status.status,
          status.errors ? JSON.stringify(status.errors) : null,
          now(),
          status.id
        );
        if (status.status === "failed") {
          audit(db, { actor: "system", action: "whatsapp.delivery_failed", subject: status.id, detail: status.errors });
        }
        handled++;
      }
    }
  }

  return { handled };
}
