import test from "node:test";
import assert from "node:assert/strict";
import { GraphClient, GraphApiError, isRetryable, backoffMs } from "../src/core/graph.js";
import { noSleep } from "./helpers.js";

function client(fetchImpl: typeof fetch, maxAttempts = 3) {
  return new GraphClient({ baseUrl: "https://graph.test", version: "v21.0", accessToken: "t", fetchImpl, maxAttempts, sleep: noSleep });
}

test("a rate limit code is retried and eventually succeeds", async () => {
  let calls = 0;
  const impl = (async () => {
    calls++;
    if (calls < 3) {
      return new Response(JSON.stringify({ error: { message: "limit", code: 4 } }), { status: 400 });
    }
    return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await client(impl).get<{ id: string }>("me");
  assert.equal(result.id, "ok");
  assert.equal(calls, 3);
});

test("an expired token is never retried", async () => {
  let calls = 0;
  const impl = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "Session expired", code: 190 } }), { status: 400 });
  }) as unknown as typeof fetch;

  await assert.rejects(() => client(impl).get("me"), (error: any) => error instanceof GraphApiError && error.code === 190);
  assert.equal(calls, 1, "retrying a bad token only delays the fix");
});

test("an HTTP 200 carrying an error body is still an error", async () => {
  const impl = (async () =>
    new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 200 })) as unknown as typeof fetch;

  await assert.rejects(() => client(impl).post("me/media", {}), /Invalid parameter/);
});

test("a dropped connection is retried", async () => {
  let calls = 0;
  const impl = (async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
  }) as unknown as typeof fetch;

  assert.deepEqual(await client(impl).get("me"), { id: "ok" });
  assert.equal(calls, 2);
});

test("the retry classification matches the Meta error codes that matter", () => {
  assert.equal(isRetryable(400, 4), true);      // app rate limit
  assert.equal(isRetryable(400, 80007), true);  // IG business rate limit
  assert.equal(isRetryable(429), true);
  assert.equal(isRetryable(503), true);
  assert.equal(isRetryable(400, 190), false);   // token
  assert.equal(isRetryable(400, 100), false);   // bad parameter
  assert.equal(isRetryable(400), false);
});

test("backoff grows and stays inside its jitter band", () => {
  const flat = () => 0.5;
  assert.equal(backoffMs(1, flat), 1000);
  assert.equal(backoffMs(2, flat), 2000);
  assert.equal(backoffMs(3, flat), 4000);
  assert.equal(backoffMs(10, flat), 30_000, "capped so a throttled worker still makes progress");
  const low = backoffMs(3, () => 0);
  const high = backoffMs(3, () => 1);
  assert.ok(low >= 3000 && high <= 5000);
});

test("the access token is attached to every call, never logged into the path", async () => {
  const seen: string[] = [];
  const impl = (async (url: any) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  await client(impl).get("17841400000000000/media", { fields: "id" });
  assert.match(seen[0]!, /access_token=t/);
  assert.match(seen[0]!, /v21\.0\/17841400000000000\/media/);
});
