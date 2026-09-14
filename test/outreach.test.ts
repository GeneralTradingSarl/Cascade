import test from "node:test";
import assert from "node:assert/strict";
import { testDb, fakeFetch, noSleep } from "./helpers.js";
import { GraphClient } from "../src/core/graph.js";
import { WhatsAppClient } from "../src/whatsapp/client.js";
import { sendToLead } from "../src/whatsapp/outreach.js";
import { captureLead, recordConsent, recordInbound, recordOptOut } from "../src/leads/store.js";

const PHONE_ID = "1234567890";
const DEFAULTS = { template: "lead_follow_up", language: "en" };

function client(fetchImpl: typeof fetch) {
  return new WhatsAppClient(
    new GraphClient({ baseUrl: "https://graph.test", version: "v21.0", accessToken: "t", fetchImpl, sleep: noSleep }),
    PHONE_ID
  );
}

function leadWith(db: ReturnType<typeof testDb>, options: { consent?: "explicit" | "inbound_message"; inboundAgo?: number; optOut?: boolean }) {
  const { lead } = captureLead(db, { source: "form", phone: "33612345678", text: "how much?" });
  if (options.consent) recordConsent(db, lead.id, options.consent, "test");
  if (options.inboundAgo !== undefined) recordInbound(db, lead.id, Math.floor(Date.now() / 1000) - options.inboundAgo);
  if (options.optOut) recordOptOut(db, lead.id, "test");
  return lead;
}

test("inside the service window the message goes out as free-form text", async () => {
  const db = testDb();
  const lead = leadWith(db, { inboundAgo: 3600 });
  const { impl, calls } = fakeFetch([{ match: "messages", body: { messages: [{ id: "wamid.1" }] } }]);

  const result = await sendToLead(db, client(impl), { leadId: lead.id, body: "Here are the details" }, DEFAULTS);

  assert.equal(result.sent, true);
  assert.equal(result.sent && result.mode, "freeform");
  assert.equal(calls[0]?.body.type, "text");
  assert.equal(calls[0]?.body.text.body, "Here are the details");
  assert.equal((db.prepare("SELECT status, provider_id FROM messages WHERE id = 1").get() as any).status, "sent");
});

test("outside the window with an opt-in, it falls back to an approved template", async () => {
  const db = testDb();
  const lead = leadWith(db, { consent: "explicit", inboundAgo: 200_000 });
  const { impl, calls } = fakeFetch([{ match: "messages", body: { messages: [{ id: "wamid.2" }] } }]);

  const result = await sendToLead(db, client(impl), { leadId: lead.id, body: "ignored outside window", templateParameters: ["Amina"] }, DEFAULTS);

  assert.equal(result.sent && result.mode, "template");
  assert.equal(calls[0]?.body.type, "template");
  assert.equal(calls[0]?.body.template.name, "lead_follow_up");
  assert.equal(calls[0]?.body.template.components[0].parameters[0].text, "Amina");
});

test("no consent and no open window means nothing is sent at all", async () => {
  const db = testDb();
  const lead = leadWith(db, {});
  const { impl, calls } = fakeFetch([{ match: "messages", body: {} }]);

  const result = await sendToLead(db, client(impl), { leadId: lead.id, body: "hi" }, DEFAULTS);

  assert.equal(result.sent, false);
  assert.equal(calls.length, 0);
  const blocked = db.prepare("SELECT action FROM audit_log WHERE action = 'whatsapp.blocked'").all();
  assert.equal(blocked.length, 1, "the refusal is recorded, not silent");
});

test("an opted-out contact is never messaged, whatever the window says", async () => {
  const db = testDb();
  const lead = leadWith(db, { consent: "explicit", inboundAgo: 60, optOut: true });
  const { impl, calls } = fakeFetch([{ match: "messages", body: {} }]);

  const result = await sendToLead(db, client(impl), { leadId: lead.id, body: "one more offer" }, DEFAULTS);

  assert.equal(result.sent, false);
  assert.match(result.reason, /opted out/);
  assert.equal(calls.length, 0);
});

test("a lead with no phone number is refused before any API call", async () => {
  const db = testDb();
  const { lead } = captureLead(db, { source: "instagram_comment", igUsername: "amina", text: "price?" });
  const { impl, calls } = fakeFetch([{ match: "messages", body: {} }]);

  const result = await sendToLead(db, client(impl), { leadId: lead.id, body: "hi" }, DEFAULTS);
  assert.equal(result.sent, false);
  assert.match(result.reason, /no phone/);
  assert.equal(calls.length, 0);
});

test("error 131047 corrects the window state instead of retrying into the same wall", async () => {
  const db = testDb();
  const lead = leadWith(db, { inboundAgo: 3600 });
  const { impl } = fakeFetch([
    {
      match: "messages",
      status: 400,
      body: { error: { message: "(#131047) Re-engagement message", code: 131047 } },
    },
  ]);

  await assert.rejects(() => sendToLead(db, client(impl), { leadId: lead.id, body: "hi" }, DEFAULTS));

  const stored = db.prepare("SELECT last_inbound_at FROM leads WHERE id = ?").get(lead.id) as any;
  assert.equal(stored.last_inbound_at, null, "the stale window must be cleared so the next send uses a template");
  assert.equal((db.prepare("SELECT status FROM messages WHERE id = 1").get() as any).status, "failed");
});
