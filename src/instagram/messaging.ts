import type { GraphClient } from "../core/graph.js";

/**
 * Instagram messaging.
 *
 * The useful endpoint here is the **private reply**: a business may answer a public comment
 * once, in the DM inbox, addressing the message to the comment id rather than to a user id.
 * That single reply is the compliant way to move a public conversation to a private one, and
 * it is the only opening the platform gives you: it must happen within 7 days of the comment,
 * and there is exactly one per comment.
 *
 * After that reply, the same 24 hour rule as WhatsApp applies to the Instagram inbox: free
 * messaging only while the conversation is live.
 */
export class InstagramMessaging {
  constructor(
    private readonly graph: GraphClient,
    private readonly accountId: string
  ) {}

  /** One private reply per comment, within 7 days. */
  async privateReply(commentId: string, text: string): Promise<{ message_id?: string }> {
    return this.graph.post(`${this.accountId}/messages`, {
      recipient: { comment_id: commentId },
      message: { text },
    });
  }

  /** Public reply under the comment. Useful as a visible acknowledgement. */
  async replyToComment(commentId: string, message: string): Promise<{ id: string }> {
    return this.graph.post(`${commentId}/replies`, { message });
  }

  async sendDirectMessage(igUserId: string, text: string): Promise<{ message_id?: string }> {
    return this.graph.post(`${this.accountId}/messages`, {
      recipient: { id: igUserId },
      message: { text },
    });
  }
}
