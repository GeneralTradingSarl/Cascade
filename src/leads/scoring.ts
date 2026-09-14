/**
 * Lead qualification.
 *
 * Rules, not a model. Two reasons: the client can read why a lead scored what it did and
 * argue with it, and a rule can be changed at 9am without retraining anything. Each rule
 * carries its own weight and returns the reason it fired, so every score is explainable in
 * the dashboard and in the audit log.
 */
export type Signal = {
  text?: string;
  hasPhone?: boolean;
  repliedToDm?: boolean;
  followsAccount?: boolean;
  source?: string;
  /** Seconds since the interaction. Fresh leads convert; four-day-old ones do not. */
  ageSeconds?: number;
};

export type Rule = {
  id: string;
  weight: number;
  describe: string;
  test: (signal: Signal) => boolean;
};

const HIGH_INTENT = /\b(price|pricing|how much|combien|tarif|prix|quote|devis|buy|acheter|book|r[ée]server|available|dispo|interested|int[ée]ress[ée]e?)\b/i;
const CONTACT_INTENT = /\b(dm|whats ?app|call me|appelle|contact|email|mail)\b/i;
const SUPPORT_INTENT = /\b(problem|issue|refund|remboursement|bug|broken|complaint)\b/i;
const NOISE = /^(\s*[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+|\s*(nice|cool|top|👏+|🔥+|super|beau|belle|wow)\s*[!.]*)$/iu;

export const RULES: Rule[] = [
  {
    id: "high_intent_language",
    weight: 40,
    describe: "asked about price, availability or booking",
    test: (s) => Boolean(s.text && HIGH_INTENT.test(s.text)),
  },
  {
    id: "asked_for_contact",
    weight: 20,
    describe: "asked to be contacted or mentioned WhatsApp",
    test: (s) => Boolean(s.text && CONTACT_INTENT.test(s.text)),
  },
  {
    id: "left_phone",
    weight: 25,
    describe: "left a phone number",
    test: (s) => Boolean(s.hasPhone),
  },
  {
    id: "replied_to_dm",
    weight: 15,
    describe: "replied in DM",
    test: (s) => Boolean(s.repliedToDm),
  },
  {
    id: "follows_account",
    weight: 5,
    describe: "already follows the account",
    test: (s) => Boolean(s.followsAccount),
  },
  {
    id: "direct_message_source",
    weight: 10,
    describe: "came through a direct message rather than a public comment",
    test: (s) => s.source === "instagram_dm",
  },
  {
    id: "stale",
    weight: -15,
    describe: "interaction is more than 48 hours old",
    test: (s) => (s.ageSeconds ?? 0) > 48 * 3600,
  },
  {
    id: "support_not_sales",
    weight: -30,
    describe: "looks like a support request, not a purchase intent",
    test: (s) => Boolean(s.text && SUPPORT_INTENT.test(s.text)),
  },
  {
    id: "emoji_only",
    weight: -25,
    describe: "comment carries no information (emoji or one-word praise)",
    test: (s) => Boolean(s.text && NOISE.test(s.text.trim())),
  },
];

export type Qualification = {
  score: number;
  qualified: boolean;
  reasons: { id: string; weight: number; describe: string }[];
};

/** Leads at or above this score are worth a human's time, and only they reach WhatsApp. */
export const QUALIFIED_AT = 40;

export function qualify(signal: Signal, rules: Rule[] = RULES): Qualification {
  const reasons = rules
    .filter((rule) => rule.test(signal))
    .map(({ id, weight, describe }) => ({ id, weight, describe }));

  const raw = reasons.reduce((total, reason) => total + reason.weight, 0);
  const score = Math.max(0, Math.min(100, raw));

  return { score, qualified: score >= QUALIFIED_AT, reasons };
}

/** Pulls a phone number out of free text, tolerating the ways people actually write them. */
export function extractPhone(text: string): string | null {
  const match = text.match(/(\+?\d[\d\s().-]{7,17}\d)/);
  if (!match?.[1]) return null;
  const digits = match[1].replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? match[1].trim() : null;
}
