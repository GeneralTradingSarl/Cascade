import type { GraphClient } from "../core/graph.js";

/** Minimal WhatsApp Cloud API surface: what a lead pipeline actually sends. */
export type TemplateParameter = { type: "text"; text: string };

export type SendResult = {
  messages?: { id: string }[];
  contacts?: { wa_id: string }[];
};

export class WhatsAppClient {
  constructor(
    private readonly graph: GraphClient,
    private readonly phoneNumberId: string
  ) {}

  /** Free-form text. Only legal inside the 24 hour service window. */
  async sendText(to: string, body: string, previewUrl = false): Promise<SendResult> {
    return this.graph.post<SendResult>(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body, preview_url: previewUrl },
    });
  }

  /** Approved template. The only legal form outside the service window. */
  async sendTemplate(
    to: string,
    template: string,
    language: string,
    parameters: TemplateParameter[] = []
  ): Promise<SendResult> {
    return this.graph.post<SendResult>(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: template,
        language: { code: language },
        ...(parameters.length > 0
          ? { components: [{ type: "body", parameters }] }
          : {}),
      },
    });
  }

  /**
   * Marks an inbound message as read. Not cosmetic: a conversation where the business never
   * reads anything reads as a bot to the contact and to WhatsApp's own quality signals.
   */
  async markRead(messageId: string): Promise<void> {
    await this.graph.post(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
  }
}

/**
 * E.164 normalisation.
 *
 * WhatsApp identifies a contact by digits only, no plus, no spaces, no leading zeros from
 * the national format. A lead who types "0612345678" in a form is a French number that must
 * become 33612345678, and getting this wrong means the message silently goes nowhere or,
 * worse, to somebody else.
 */
export function normalisePhone(input: string, defaultCountryCode?: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (!hasPlus && defaultCountryCode) {
    const cc = defaultCountryCode.replace(/\D/g, "");
    if (digits.startsWith("00")) {
      digits = digits.slice(2);
    } else if (digits.startsWith("0")) {
      digits = cc + digits.slice(1);
    } else if (!digits.startsWith(cc)) {
      digits = cc + digits;
    }
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  // E.164 allows at most 15 digits and a country code is at least one, so anything outside
  // this range is a typo rather than a phone number.
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}
