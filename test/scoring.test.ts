import test from "node:test";
import assert from "node:assert/strict";
import { qualify, extractPhone, QUALIFIED_AT } from "../src/leads/scoring.js";
import { normalisePhone } from "../src/whatsapp/client.js";

test("a price question qualifies", () => {
  const result = qualify({ text: "Hi! How much for the 3 day package?", source: "instagram_comment" });
  assert.ok(result.score >= QUALIFIED_AT);
  assert.equal(result.qualified, true);
  assert.ok(result.reasons.some((r) => r.id === "high_intent_language"));
});

test("French intent is scored like English intent", () => {
  const result = qualify({ text: "Bonjour, c'est quel prix svp ?", source: "instagram_comment" });
  assert.equal(result.qualified, true);
});

test("emoji praise does not qualify", () => {
  assert.equal(qualify({ text: "🔥🔥🔥" }).qualified, false);
  assert.equal(qualify({ text: "nice!" }).qualified, false);
});

test("a support request is pushed below the bar even when it sounds urgent", () => {
  const result = qualify({ text: "I need a refund for my order, this is broken", source: "instagram_dm" });
  assert.equal(result.qualified, false);
  assert.ok(result.reasons.some((r) => r.id === "support_not_sales"));
});

test("a stale interaction loses points", () => {
  const fresh = qualify({ text: "interested, how much?", ageSeconds: 60 });
  const stale = qualify({ text: "interested, how much?", ageSeconds: 5 * 86_400 });
  assert.ok(stale.score < fresh.score);
});

test("the score is capped to 0..100 and every point is explained", () => {
  const result = qualify({
    text: "how much? can you whatsapp me on 0612345678",
    hasPhone: true,
    repliedToDm: true,
    followsAccount: true,
    source: "instagram_dm",
  });
  assert.ok(result.score <= 100);
  assert.ok(result.reasons.length >= 4);
  assert.equal(
    result.score,
    Math.min(100, result.reasons.reduce((total, reason) => total + reason.weight, 0))
  );
});

test("phone numbers are found in the middle of a sentence", () => {
  assert.equal(extractPhone("call me on +33 6 12 34 56 78 please"), "+33 6 12 34 56 78");
  assert.equal(extractPhone("no number here"), null);
  assert.equal(extractPhone("order 12345"), null);
});

test("national formats are normalised to E.164 digits", () => {
  assert.equal(normalisePhone("0612345678", "33"), "33612345678");
  assert.equal(normalisePhone("+33 6 12 34 56 78"), "33612345678");
  assert.equal(normalisePhone("0033612345678"), "33612345678");
  assert.equal(normalisePhone("(229) 97 00 00 00", "229"), "22997000000");
  assert.equal(normalisePhone("12345", "33"), null);
  assert.equal(normalisePhone("", "33"), null);
});
