import test from "node:test";
import assert from "node:assert/strict";
import { testDb, fakeFetch, noSleep } from "./helpers.js";
import { GraphClient } from "../src/core/graph.js";
import { InstagramPublisher } from "../src/instagram/publisher.js";

const ACCOUNT = "17841400000000000";

function publisher(fetchImpl: typeof fetch, db = testDb(), limit = 50) {
  const graph = new GraphClient({
    baseUrl: "https://graph.test",
    version: "v21.0",
    accessToken: "token",
    fetchImpl,
    sleep: noSleep,
  });
  return { publisher: new InstagramPublisher(graph, db, ACCOUNT, limit, noSleep), db };
}

test("an image post creates a container, waits for it, then publishes", async () => {
  const { impl, calls } = fakeFetch([
    { match: `${ACCOUNT}/media`, body: { id: "container-1" }, once: true },
    { match: "container-1", body: { status_code: "FINISHED" } },
    { match: `${ACCOUNT}/media_publish`, body: { id: "media-1" } },
    { match: "media-1", body: { permalink: "https://instagram.com/p/abc" } },
  ]);
  const { publisher: pub, db } = publisher(impl);

  const result = await pub.publish({ idempotencyKey: "post-1", kind: "image", caption: "hello", media: ["https://cdn/img.jpg"] });

  assert.equal(result.mediaId, "media-1");
  assert.equal(result.permalink, "https://instagram.com/p/abc");
  assert.equal((db.prepare("SELECT status FROM posts WHERE idempotency_key = 'post-1'").get() as any).status, "published");

  const create = calls.find((call) => call.url.includes(`${ACCOUNT}/media`) && call.method === "POST");
  assert.equal(create?.body.image_url, "https://cdn/img.jpg");
  assert.equal(create?.body.caption, "hello");
});

test("publishing the same idempotency key twice does not post twice", async () => {
  const { impl, calls } = fakeFetch([
    { match: `${ACCOUNT}/media`, body: { id: "container-1" }, once: true },
    { match: "container-1", body: { status_code: "FINISHED" } },
    { match: `${ACCOUNT}/media_publish`, body: { id: "media-1" } },
    { match: "media-1", body: { permalink: "https://instagram.com/p/abc" } },
  ]);
  const { publisher: pub } = publisher(impl);

  await pub.publish({ idempotencyKey: "post-1", kind: "image", media: ["https://cdn/img.jpg"] });
  const publishCallsBefore = calls.filter((call) => call.url.includes("media_publish")).length;

  const second = await pub.publish({ idempotencyKey: "post-1", kind: "image", media: ["https://cdn/img.jpg"] });

  assert.equal(second.mediaId, "media-1");
  assert.equal(calls.filter((call) => call.url.includes("media_publish")).length, publishCallsBefore);
});

test("a reel is polled until Instagram finishes transcoding", async () => {
  let statusChecks = 0;
  const impl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    if (url.includes("media_publish")) return respond({ id: "media-reel" });
    if (url.includes(`${ACCOUNT}/media`) && init.method === "POST") return respond({ id: "container-reel" });
    if (url.includes("container-reel")) {
      statusChecks++;
      return respond({ status_code: statusChecks < 3 ? "IN_PROGRESS" : "FINISHED" });
    }
    return respond({ permalink: "https://instagram.com/reel/x" });
  }) as unknown as typeof fetch;

  const { publisher: pub } = publisher(impl);
  const result = await pub.publish({ idempotencyKey: "reel-1", kind: "reel", media: ["https://cdn/clip.mp4"] });

  assert.equal(result.mediaId, "media-reel");
  assert.equal(statusChecks, 3, "it must not publish a container that is still processing");
});

test("a container that errors is a permanent failure, not a retry", async () => {
  const impl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes(`${ACCOUNT}/media`) && init.method === "POST") return respond({ id: "container-bad" });
    return respond({ status_code: "ERROR", status: "Media download failed" });
  }) as unknown as typeof fetch;

  const { publisher: pub, db } = publisher(impl);

  await assert.rejects(
    () => pub.publish({ idempotencyKey: "bad-1", kind: "image", media: ["https://cdn/404.jpg"] }),
    (error: any) => error.retryable === false && /Media download failed/.test(error.message)
  );
  const row = db.prepare("SELECT status, error FROM posts WHERE idempotency_key = 'bad-1'").get() as any;
  assert.equal(row.status, "failed");
});

test("a carousel creates one child container per item plus the parent", async () => {
  const created: any[] = [];
  const impl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(init.body) : {};
    const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });

    if (url.includes("media_publish")) return respond({ id: "media-carousel" });
    if (url.includes(`${ACCOUNT}/media`) && init.method === "POST") {
      created.push(body);
      return respond({ id: body.is_carousel_item ? `child-${created.length}` : "parent-1" });
    }
    if (url.includes("parent-1")) return respond({ status_code: "FINISHED" });
    return respond({ permalink: "https://instagram.com/p/carousel" });
  }) as unknown as typeof fetch;

  const { publisher: pub } = publisher(impl);
  await pub.publish({
    idempotencyKey: "car-1",
    kind: "carousel",
    caption: "three shots",
    media: ["https://cdn/1.jpg", "https://cdn/2.jpg", "https://cdn/3.jpg"],
  });

  assert.equal(created.filter((body) => body.is_carousel_item).length, 3);
  const parent = created.find((body) => body.media_type === "CAROUSEL");
  assert.equal(parent.children, "child-1,child-2,child-3");
  assert.equal(parent.caption, "three shots");
});

test("the daily publishing quota is enforced before calling the API", async () => {
  const db = testDb();
  const { impl, calls } = fakeFetch([{ match: "anything", body: {} }]);
  const { publisher: pub } = publisher(impl, db, 1);

  const timestamp = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO posts (idempotency_key, kind, media, status, published_at, created_at, updated_at) VALUES ('done','image','[]','published',?,?,?)"
  ).run(timestamp, timestamp, timestamp);

  assert.equal(pub.quotaRemaining(), 0);
  await assert.rejects(
    () => pub.publish({ idempotencyKey: "over-quota", kind: "image", media: ["https://cdn/x.jpg"] }),
    /quota reached/
  );
  assert.equal(calls.length, 0, "no request should reach Instagram once the quota is spent");
});
