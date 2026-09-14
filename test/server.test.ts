import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createServer } from "../src/server.js";
import { testConfig, testDb, fakeFetch } from "./helpers.js";
import { signPayload } from "../src/webhooks/verify.js";

async function withServer(run: (base: string, app: ReturnType<typeof createApp>) => Promise<void>) {
  const { impl } = fakeFetch([{ match: "graph.test", body: { messages: [{ id: "wamid.x" }] } }]);
  const app = createApp({ config: testConfig(), db: testDb(), fetchImpl: impl });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}`, app);
  } finally {
    server.close();
  }
}

test("/api is closed without the shared key", async () => {
  await withServer(async (base) => {
    const anonymous = await fetch(`${base}/api/leads`);
    assert.equal(anonymous.status, 401);

    const wrong = await fetch(`${base}/api/leads`, { headers: { "x-cascade-key": "guess" } });
    assert.equal(wrong.status, 401);

    const right = await fetch(`${base}/api/leads`, { headers: { "x-cascade-key": "test-key" } });
    assert.equal(right.status, 200);
  });
});

test("the webhook subscription handshake echoes the challenge", async () => {
  await withServer(async (base) => {
    const ok = await fetch(`${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=42`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "42");

    const bad = await fetch(`${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
    assert.equal(bad.status, 403);
  });
});

test("an unsigned webhook post is refused", async () => {
  await withServer(async (base, app) => {
    const body = JSON.stringify({ entry: [] });

    const unsigned = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", body });
    assert.equal(unsigned.status, 403);

    const signed = await fetch(`${base}/webhooks/whatsapp`, {
      method: "POST",
      headers: { "x-hub-signature-256": signPayload(body, "app-secret") },
      body,
    });
    assert.equal(signed.status, 200);

    const refusals = app.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'webhook.bad_signature'").get() as any;
    assert.equal(Number(refusals.c), 1);
  });
});

test("a lead posted by n8n is captured, scored and returned", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/leads`, {
      method: "POST",
      headers: { "x-cascade-key": "test-key", "content-type": "application/json" },
      body: JSON.stringify({ source: "form", name: "Amina", phone: "0612345678", defaultCountryCode: "33", text: "what is your price?" }),
    });

    assert.equal(response.status, 201);
    const payload = (await response.json()) as any;
    assert.equal(payload.lead.phone, "33612345678");
    assert.equal(payload.lead.stage, "qualified");

    const list = await fetch(`${base}/api/leads?stage=qualified`, { headers: { "x-cascade-key": "test-key" } });
    assert.equal(((await list.json()) as any).leads.length, 1);
  });
});

test("/health reports the quota and the queue depth", async () => {
  await withServer(async (base) => {
    const payload = (await (await fetch(`${base}/health`)).json()) as any;
    assert.equal(payload.status, "ok");
    assert.equal(payload.instagramQuotaRemaining, 50);
    assert.equal(payload.jobsDead, 0);
  });
});
