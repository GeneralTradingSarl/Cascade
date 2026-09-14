import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta webhook authenticity.
 *
 * Two separate mechanisms, both mandatory, and both easy to get subtly wrong:
 *
 *  - **Subscription handshake (GET).** Meta calls the endpoint with `hub.mode=subscribe`,
 *    `hub.verify_token` and `hub.challenge`. The challenge must be echoed as plain text,
 *    and the token compared in constant time.
 *  - **Payload signature (POST).** `X-Hub-Signature-256` is `sha256=` + HMAC-SHA256 of the
 *    RAW request body using the app secret. It must be computed on the exact bytes received.
 *    Parsing the JSON first and re-serialising it changes key order and whitespace, the
 *    signature stops matching, and the usual "fix" is to skip verification, which leaves an
 *    open endpoint that anybody can post fake leads to.
 */
export function verifySubscription(
  query: URLSearchParams,
  expectedToken: string
): { ok: true; challenge: string } | { ok: false; reason: string } {
  if (query.get("hub.mode") !== "subscribe") return { ok: false, reason: "unexpected hub.mode" };

  const token = query.get("hub.verify_token") ?? "";
  if (!constantTimeEquals(token, expectedToken)) return { ok: false, reason: "verify token mismatch" };

  const challenge = query.get("hub.challenge");
  if (!challenge) return { ok: false, reason: "missing hub.challenge" };

  return { ok: true, challenge };
}

export function signPayload(rawBody: string | Buffer, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

export function verifySignature(rawBody: string | Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  return constantTimeEquals(header, signPayload(rawBody, appSecret));
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length. Compare a
  // fixed-size digest of each side instead so the comparison is always the same shape.
  const leftDigest = createHmac("sha256", "cascade-compare").update(left).digest();
  const rightDigest = createHmac("sha256", "cascade-compare").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
