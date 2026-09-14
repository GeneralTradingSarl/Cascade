/**
 * Boots the console against an in-memory database filled with a plausible day of activity.
 * No credentials, no network: `npm run demo` and open http://localhost:8080.
 */
import { createApp } from "../src/app.js";
import { createServer } from "../src/server.js";
import { openDatabase, now } from "../src/core/db.js";
import { captureLead, recordConsent, recordInbound, recordOptOut, setStage } from "../src/leads/store.js";
import type { Config } from "../src/config.js";

const config: Config = {
  port: Number(process.env.PORT ?? 8080),
  databasePath: ":memory:",
  publicUrl: "http://localhost:8080",
  meta: { appSecret: "demo", verifyToken: "demo", graphVersion: "v21.0", graphBaseUrl: "https://graph.facebook.com" },
  instagram: { accountId: "demo", accessToken: "demo", dailyPublishLimit: 50 },
  whatsapp: { phoneNumberId: "demo", accessToken: "demo", reengagementTemplate: "lead_follow_up", templateLanguage: "en" },
  apiKey: process.env.CASCADE_API_KEY ?? "demo-key",
};

const db = openDatabase(":memory:");
const app = createApp({ config, db, fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });

const hoursAgo = (hours: number) => now() - Math.round(hours * 3600);

const seed = [
  { source: "instagram_comment", igUsername: "amina.k", name: "Amina", text: "How much for the 6 week programme?", consent: "explicit" as const, inbound: 2 },
  { source: "instagram_dm", igUsername: "marc_ff", name: "Marc", text: "Can you whatsapp me the details? 0612345678", consent: "explicit" as const, inbound: 30 },
  { source: "instagram_comment", igUsername: "sportif229", text: "🔥🔥" },
  { source: "form", name: "Chloé", phone: "33698765432", text: "Interested in the coaching, what is the price?", consent: "explicit" as const },
  { source: "whatsapp_inbound", name: "Yann", phone: "33677001122", text: "hello, still available?", inbound: 0.5 },
  { source: "instagram_comment", igUsername: "reclamation_x", text: "I want a refund, the order is broken" },
  { source: "instagram_dm", igUsername: "spam_bot_99", name: "Bot", text: "check my page", optOut: true, phone: "33600000000" },
];

for (const entry of seed) {
  const { lead } = captureLead(db, {
    source: entry.source,
    igUsername: entry.igUsername,
    name: entry.name,
    phone: entry.phone,
    text: entry.text,
    defaultCountryCode: "33",
  });
  if (entry.consent) recordConsent(db, lead.id, entry.consent, "demo seed");
  if (entry.inbound !== undefined) recordInbound(db, lead.id, hoursAgo(entry.inbound));
  if (entry.optOut) recordOptOut(db, lead.id, "wrote STOP");
  if (entry.consent && entry.inbound !== undefined) setStage(db, lead.id, "contacted");
}

const posts = [
  ["brief-114", "carousel", "Three mistakes that stall progress in week 3. Which one hits closest?", "published", hoursAgo(5)],
  ["brief-115", "reel", "60 seconds on why the first session is free.", "published", hoursAgo(28)],
  ["brief-116", "image", "New slots for October. Comment PRICE and I'll send the details.", "approved", null],
  ["brief-117", "image", "Draft waiting for review.", "draft", null],
];
for (const [key, kind, caption, status, publishedAt] of posts) {
  db.prepare(
    "INSERT INTO posts (idempotency_key, kind, caption, media, status, permalink, published_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(key, kind, caption, '["https://example.com/media.jpg"]', status, publishedAt ? "https://instagram.com/p/demo" : null, publishedAt, hoursAgo(30), now());
}

const messages = [
  [1, "out", "Hi Amina, thanks for asking. Here is the programme outline.", null, "read", hoursAgo(1.8)],
  [1, "in", "Perfect, can I start next Monday?", null, "delivered", hoursAgo(1.5)],
  [2, "out", null, "lead_follow_up", "delivered", hoursAgo(26)],
  [5, "in", "hello, still available?", null, "delivered", hoursAgo(0.5)],
  [7, "out", "Understood, you will not receive any further messages from us.", null, "sent", hoursAgo(20)],
];
for (const [leadId, direction, body, template, status, at] of messages) {
  db.prepare(
    "INSERT INTO messages (lead_id, channel, direction, provider_id, body, template, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(leadId, "whatsapp", direction, `wamid.demo.${Math.random().toString(36).slice(2, 9)}`, body, template, status, at, at);
}

app.queue.enqueue("instagram.publish", { postId: 3 }, { delaySeconds: 3600 });

createServer(app).listen(config.port, () => {
  console.log(`cascade demo console on http://localhost:${config.port} (api key: ${config.apiKey})`);
});
