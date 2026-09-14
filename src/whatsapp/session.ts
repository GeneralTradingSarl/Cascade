/**
 * The WhatsApp 24 hour customer service window.
 *
 * This single rule decides whether a message is allowed, what it may contain, and what it
 * costs, and it is the rule most integrations discover the hard way:
 *
 *  - Within 24 hours of the contact's most recent inbound message, the business may reply
 *    with free-form content.
 *  - Outside it, only a pre-approved template may be sent, and marketing templates require
 *    the contact to have opted in.
 *  - Sending free-form outside the window does not "mostly work": the API rejects it
 *    (error 131047), and a pattern of rejected or unwanted sends drags the number's quality
 *    rating down to the point where the daily messaging limit is cut.
 *
 * So the decision is made here, before anything is sent, and the reason is recorded.
 */
export const SERVICE_WINDOW_SECONDS = 24 * 60 * 60;

export type SendDecision =
  | { allowed: true; mode: "freeform"; reason: string }
  | { allowed: true; mode: "template"; reason: string }
  | { allowed: false; reason: string };

export type ContactState = {
  /** Unix seconds of the contact's last inbound message, if any. */
  lastInboundAt?: number | null;
  /** none | explicit | inbound_message */
  consent: string;
  optedOutAt?: number | null;
};

export function decideSend(
  contact: ContactState,
  at: number = Math.floor(Date.now() / 1000)
): SendDecision {
  if (contact.optedOutAt) {
    return { allowed: false, reason: "contact opted out" };
  }

  const withinWindow =
    contact.lastInboundAt != null && at - contact.lastInboundAt < SERVICE_WINDOW_SECONDS;

  if (withinWindow) {
    // An inbound message is itself consent to reply to that conversation.
    return { allowed: true, mode: "freeform", reason: "within 24h service window" };
  }

  if (contact.consent === "explicit") {
    return { allowed: true, mode: "template", reason: "outside window, explicit opt-in on file" };
  }

  if (contact.consent === "inbound_message") {
    // They wrote to us once, but the window has closed. A template is the only legal form,
    // and it must be a utility or service template rather than marketing.
    return { allowed: true, mode: "template", reason: "outside window, prior inbound contact" };
  }

  return { allowed: false, reason: "no consent on file and no open service window" };
}

export function windowExpiresAt(lastInboundAt: number): number {
  return lastInboundAt + SERVICE_WINDOW_SECONDS;
}

/**
 * Opt-out detection. Deliberately conservative: a contact who writes anything that reads
 * like a refusal is opted out, because the cost of a false positive is one lost lead and
 * the cost of a false negative is a spam report.
 */
const OPT_OUT_PATTERNS = [
  /^\s*stop\b/i,
  /^\s*unsubscribe\b/i,
  /^\s*désabonn/i,
  /\bremove me\b/i,
  /\bdon'?t (message|contact|text) me\b/i,
  /\bne me (contactez|recontactez) plus\b/i,
  /\barr[êe]tez? de m'?[ée]crire\b/i,
];

export function isOptOut(body: string): boolean {
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(body));
}
