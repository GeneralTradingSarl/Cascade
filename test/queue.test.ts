import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { JobQueue } from "../src/core/queue.js";

test("a job runs once and is marked done", async () => {
  const db = testDb();
  const queue = new JobQueue(db);
  let seen: unknown;

  queue.register("demo", async (payload) => {
    seen = payload;
  });
  queue.enqueue("demo", { leadId: 7 });

  assert.equal(await queue.drain(), 1);
  assert.deepEqual(seen, { leadId: 7 });
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 1").get() as any).status, "done");
  assert.equal(await queue.drain(), 0, "a completed job is not picked up again");
});

test("a failing job is rescheduled with backoff, not lost", async () => {
  const db = testDb();
  const queue = new JobQueue(db);
  queue.register("flaky", async () => {
    throw new Error("upstream 500");
  });
  queue.enqueue("flaky", {});

  await queue.drain();
  const job = db.prepare("SELECT status, attempts, run_at, last_error FROM jobs WHERE id = 1").get() as any;
  assert.equal(job.status, "pending");
  assert.equal(job.attempts, 1);
  assert.match(job.last_error, /upstream 500/);
  assert.ok(job.run_at > Math.floor(Date.now() / 1000), "it must be scheduled in the future");
});

test("a job that will never succeed is dead-lettered rather than retried forever", async () => {
  const db = testDb();
  const queue = new JobQueue(db);
  queue.register("fatal", async () => {
    throw Object.assign(new Error("invalid token"), { retryable: false });
  });
  queue.enqueue("fatal", {});

  await queue.drain();
  const job = db.prepare("SELECT status, last_error FROM jobs WHERE id = 1").get() as any;
  assert.equal(job.status, "dead");
  assert.match(job.last_error, /invalid token/);
});

test("attempts are capped and the row is kept for an operator to see", async () => {
  const db = testDb();
  const queue = new JobQueue(db);
  queue.register("always-fails", async () => {
    throw new Error("nope");
  });
  queue.enqueue("always-fails", {}, { maxAttempts: 2 });

  await queue.drain();
  db.prepare("UPDATE jobs SET run_at = 0 WHERE id = 1").run(); // skip the backoff delay
  await queue.drain();

  const job = db.prepare("SELECT status, attempts FROM jobs WHERE id = 1").get() as any;
  assert.equal(job.status, "dead");
  assert.equal(job.attempts, 2);
});

test("an unknown job kind is dead-lettered immediately", async () => {
  const db = testDb();
  const queue = new JobQueue(db);
  queue.enqueue("does-not-exist", {});
  await queue.drain();
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 1").get() as any).status, "dead");
});

test("a delayed job is not due yet", async () => {
  const db = testDb();
  const queue = new JobQueue(db);
  queue.register("later", async () => {});
  queue.enqueue("later", {}, { delaySeconds: 600 });
  assert.equal(await queue.drain(), 0);
});
