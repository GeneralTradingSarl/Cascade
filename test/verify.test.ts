import test from "node:test";
import assert from "node:assert/strict";
import { signPayload, verifySignature, verifySubscription } from "../src/webhooks/verify.js";

const SECRET = "app-secret";

test("a correctly signed payload verifies", () => {
  const body = JSON.stringify({ entry: [{ id: "1" }] });
  assert.equal(verifySignature(body, signPayload(body, SECRET), SECRET), true);
});

test("a payload modified in transit does not verify", () => {
  const body = JSON.stringify({ entry: [{ id: "1" }] });
  const signature = signPayload(body, SECRET);
  const tampered = JSON.stringify({ entry: [{ id: "2" }] });
  assert.equal(verifySignature(tampered, signature, SECRET), false);
});

test("re-serialising the body breaks the signature, which is why raw bytes are kept", () => {
  const raw = '{"a":1,  "b":2}';
  const signature = signPayload(raw, SECRET);
  const reserialised = JSON.stringify(JSON.parse(raw));
  assert.equal(verifySignature(reserialised, signature, SECRET), false);
  assert.equal(verifySignature(raw, signature, SECRET), true);
});

test("a missing or malformed header is rejected", () => {
  const body = "{}";
  assert.equal(verifySignature(body, undefined, SECRET), false);
  assert.equal(verifySignature(body, "sha1=deadbeef", SECRET), false);
  assert.equal(verifySignature(body, "", SECRET), false);
});

test("the wrong app secret is rejected", () => {
  const body = "{}";
  assert.equal(verifySignature(body, signPayload(body, "other-secret"), SECRET), false);
});

test("the subscription handshake echoes the challenge only for the right token", () => {
  const good = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "12345" });
  const result = verifySubscription(good, "tok");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.challenge, "12345");

  const bad = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "12345" });
  assert.equal(verifySubscription(bad, "tok").ok, false);

  const wrongMode = new URLSearchParams({ "hub.mode": "unsubscribe", "hub.verify_token": "tok", "hub.challenge": "1" });
  assert.equal(verifySubscription(wrongMode, "tok").ok, false);
});
