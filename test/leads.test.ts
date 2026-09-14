import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { captureLead, claimEvent, getLead, getLeadByPhone, recordConsent, recordInbound, recordOptOut } from "../src/leads/store.js";

test("a comment with intent is captured and qualified", () => {
  const db = testDb();
  const { lead, created } = captureLead(db, {
    source: "instagram_comment",
    sourceRef: "c1",
    igUsername: "amina",
    text: "how much is the coaching?",
  });

  assert.equal(created, true);
  assert.equal(lead.stage, "qualified");
  assert.ok(lead.score >= 40);
  assert.equal(lead.consent, "none", "a comment is never consent to be messaged");
});

test("the same person commenting twice is one lead, keeping the best score", () => {
  const db = testDb();
  captureLead(db, { source: "instagram_comment", igUsername: "amina", text: "what is the price?" });
  const second = captureLead(db, { source: "instagram_comment", igUsername: "Amina", text: "🔥" });

  assert.equal(second.created, false);
  assert.ok(second.lead.score >= 40, "a later emoji comment must not undo earlier intent");
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS c FROM leads").get() as any).c), 1);
});

test("a phone number in the text becomes the deduplication key", () => {
  const db = testDb();
  const first = captureLead(db, { source: "instagram_dm", text: "price? +33 6 12 34 56 78", igUsername: "one" });
  const second = captureLead(db, { source: "form", phone: "0612345678", defaultCountryCode: "33", igUsername: "two" });

  assert.equal(second.created, false);
  assert.equal(second.lead.id, first.lead.id);
  assert.equal(second.lead.phone, "33612345678");
});

test("consent is recorded with its source and can be withdrawn", () => {
  const db = testDb();
  const { lead } = captureLead(db, { source: "form", phone: "33612345678", text: "send me the details" });

  recordConsent(db, lead.id, "explicit", "web form checkbox");
  let stored = getLead(db, lead.id)!;
  assert.equal(stored.consent, "explicit");
  assert.equal(stored.consent_source, "web form checkbox");
  assert.ok(stored.consent_at);

  recordOptOut(db, lead.id, "wrote STOP");
  stored = getLead(db, lead.id)!;
  assert.ok(stored.opted_out_at);
  assert.equal(stored.stage, "rejected");

  const audits = db.prepare("SELECT action FROM audit_log ORDER BY id").all() as { action: string }[];
  assert.ok(audits.some((a) => a.action === "lead.consent"));
  assert.ok(audits.some((a) => a.action === "lead.opt_out"));
});

test("an inbound message updates the window timestamp", () => {
  const db = testDb();
  const { lead } = captureLead(db, { source: "whatsapp_inbound", phone: "33612345678", text: "hello" });
  recordInbound(db, lead.id, 1_700_000_000);
  assert.equal(getLead(db, lead.id)!.last_inbound_at, 1_700_000_000);
  assert.equal(getLeadByPhone(db, "33612345678")!.id, lead.id);
});

test("an event id can only be claimed once, so a webhook retry is a no-op", () => {
  const db = testDb();
  assert.equal(claimEvent(db, "wamid.ABC", "wa_message"), true);
  assert.equal(claimEvent(db, "wamid.ABC", "wa_message"), false);
  assert.equal(claimEvent(db, "wamid.DEF", "wa_message"), true);
});
