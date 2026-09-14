import test from "node:test";
import assert from "node:assert/strict";
import { decideSend, isOptOut, SERVICE_WINDOW_SECONDS, windowExpiresAt } from "../src/whatsapp/session.js";

const NOW = 1_800_000_000;

test("free-form is allowed inside the 24 hour window", () => {
  const decision = decideSend({ lastInboundAt: NOW - 3600, consent: "none" }, NOW);
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.mode, "freeform");
});

test("one second past the window, free-form is no longer an option", () => {
  const justInside = decideSend({ lastInboundAt: NOW - (SERVICE_WINDOW_SECONDS - 1), consent: "none" }, NOW);
  assert.equal(justInside.allowed && justInside.mode, "freeform");

  const justOutside = decideSend({ lastInboundAt: NOW - SERVICE_WINDOW_SECONDS, consent: "none" }, NOW);
  assert.equal(justOutside.allowed, false);
});

test("outside the window, an explicit opt-in permits a template", () => {
  const decision = decideSend({ lastInboundAt: NOW - 200_000, consent: "explicit" }, NOW);
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.mode, "template");
});

test("no consent and no open window means nothing is sent", () => {
  const decision = decideSend({ consent: "none" }, NOW);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /no consent/);
});

test("an opt-out beats every other permission", () => {
  const decision = decideSend(
    { lastInboundAt: NOW - 60, consent: "explicit", optedOutAt: NOW - 10 },
    NOW
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /opted out/);
});

test("window expiry is exactly 24 hours after the inbound message", () => {
  assert.equal(windowExpiresAt(NOW), NOW + 86_400);
});

test("opt-out detection covers the phrasings people actually use", () => {
  for (const phrase of ["STOP", "stop please", "Unsubscribe", "remove me from this list", "ne me contactez plus", "désabonnez-moi", "don't message me again"]) {
    assert.equal(isOptOut(phrase), true, `expected opt-out for: ${phrase}`);
  }
  for (const phrase of ["stopped by your shop today", "how much for the full stop sign", "yes please send it"]) {
    assert.equal(isOptOut(phrase), false, `did not expect opt-out for: ${phrase}`);
  }
});
