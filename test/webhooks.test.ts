import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { handleInstagramWebhook, handleWhatsAppWebhook } from "../src/webhooks/router.js";
import { getLeadByPhone } from "../src/leads/store.js";

function collector() {
  const jobs: { kind: string; payload: Record<string, unknown> }[] = [];
  return { jobs, enqueue: (kind: string, payload: Record<string, unknown>) => void jobs.push({ kind, payload }) };
}

const igComment = (id: string, text: string) => ({
  entry: [
    {
      id: "ig-account",
      changes: [
        {
          field: "comments",
          value: { id, text, from: { id: "u1", username: "amina" }, timestamp: Math.floor(Date.now() / 1000) },
        },
      ],
    },
  ],
});

const waMessage = (id: string, body: string, from = "33612345678") => ({
  entry: [
    {
      id: "wa",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            contacts: [{ profile: { name: "Amina" }, wa_id: from }],
            messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
          },
        },
      ],
    },
  ],
});

test("a qualified Instagram comment captures a lead and queues a private reply", () => {
  const db = testDb();
  const { jobs, enqueue } = collector();

  const result = handleInstagramWebhook(db, igComment("c-1", "How much for a session?"), enqueue);

  assert.equal(result.handled, 1);
  assert.equal(jobs[0]?.kind, "instagram.reply_dm");
  const lead = db.prepare("SELECT * FROM leads").get() as any;
  assert.equal(lead.ig_username, "amina");
  assert.equal(lead.consent, "none");
});

test("a low-intent comment is stored but nothing is sent", () => {
  const db = testDb();
  const { jobs, enqueue } = collector();

  handleInstagramWebhook(db, igComment("c-2", "🔥"), enqueue);

  assert.equal(jobs.length, 0);
  assert.equal((db.prepare("SELECT stage FROM leads").get() as any).stage, "new");
});

test("Meta redelivering the same comment does not produce a second lead or a second DM", () => {
  const db = testDb();
  const { jobs, enqueue } = collector();
  const payload = igComment("c-3", "price please");

  handleInstagramWebhook(db, payload, enqueue);
  handleInstagramWebhook(db, payload, enqueue);

  assert.equal(Number((db.prepare("SELECT COUNT(*) AS c FROM leads").get() as any).c), 1);
  assert.equal(jobs.length, 1);
});

test("an inbound WhatsApp message opens the window and counts as consent to reply", () => {
  const db = testDb();
  const { jobs, enqueue } = collector();

  handleWhatsAppWebhook(db, waMessage("wamid.1", "Hi, I saw your post"), enqueue);

  const lead = getLeadByPhone(db, "33612345678")!;
  assert.ok(lead.last_inbound_at);
  assert.equal(lead.consent, "inbound_message");
  assert.equal(jobs[0]?.kind, "whatsapp.handle_inbound");
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS c FROM messages WHERE direction = 'in'").get() as any).c), 1);
});

test("STOP opts the contact out and queues exactly one confirmation", () => {
  const db = testDb();
  const { jobs, enqueue } = collector();

  handleWhatsAppWebhook(db, waMessage("wamid.2", "STOP"), enqueue);

  const lead = getLeadByPhone(db, "33612345678")!;
  assert.ok(lead.opted_out_at);
  assert.equal(lead.stage, "rejected");
  assert.equal(jobs.filter((job) => job.kind === "whatsapp.confirm_opt_out").length, 1);
  assert.equal(jobs.filter((job) => job.kind === "whatsapp.handle_inbound").length, 0);
});

test("delivery statuses update the outbound message row", () => {
  const db = testDb();
  const { enqueue } = collector();
  const timestamp = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO messages (channel, direction, provider_id, body, status, created_at, updated_at) VALUES ('whatsapp','out','wamid.out','hi','sent',?,?)"
  ).run(timestamp, timestamp);

  handleWhatsAppWebhook(
    db,
    { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.out", status: "delivered" }] } }] }] },
    enqueue
  );
  assert.equal((db.prepare("SELECT status FROM messages WHERE provider_id = 'wamid.out'").get() as any).status, "delivered");

  handleWhatsAppWebhook(
    db,
    { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.out", status: "failed", errors: [{ code: 131049 }] }] } }] }] },
    enqueue
  );
  const row = db.prepare("SELECT status, error FROM messages WHERE provider_id = 'wamid.out'").get() as any;
  assert.equal(row.status, "failed");
  assert.match(row.error, /131049/);
});

test("an Instagram DM is captured with its higher intent weighting", () => {
  const db = testDb();
  const { jobs, enqueue } = collector();

  handleInstagramWebhook(
    db,
    {
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: { id: "m-1", from: { username: "amina" }, message: { text: "interested, what is the price?" } },
            },
          ],
        },
      ],
    },
    enqueue
  );

  assert.equal(jobs[0]?.kind, "lead.route");
  const lead = db.prepare("SELECT * FROM leads").get() as any;
  assert.equal(lead.source, "instagram_dm");
  assert.ok(lead.score >= 40);
});
