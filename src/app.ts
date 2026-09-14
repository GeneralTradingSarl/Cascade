import { loadConfig, type Config } from "./config.js";
import { openDatabase, audit, type Db } from "./core/db.js";
import { GraphClient } from "./core/graph.js";
import { JobQueue } from "./core/queue.js";
import { InstagramPublisher } from "./instagram/publisher.js";
import { InstagramMessaging } from "./instagram/messaging.js";
import { WhatsAppClient } from "./whatsapp/client.js";
import { sendToLead } from "./whatsapp/outreach.js";
import { getLead, setStage } from "./leads/store.js";

/**
 * Composition root. Everything is constructed here and passed down, so a test can build the
 * same object graph with a fake fetch and an in-memory database and exercise the real code.
 */
export type App = {
  config: Config;
  db: Db;
  queue: JobQueue;
  publisher: InstagramPublisher;
  messaging: InstagramMessaging;
  whatsapp: WhatsAppClient;
};

export function createApp(options: { config?: Config; db?: Db; fetchImpl?: typeof fetch } = {}): App {
  const config = options.config ?? loadConfig();
  const db = options.db ?? openDatabase(config.databasePath);

  const graph = (accessToken: string) =>
    new GraphClient({
      baseUrl: config.meta.graphBaseUrl,
      version: config.meta.graphVersion,
      accessToken,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

  const igGraph = graph(config.instagram.accessToken);
  const waGraph = graph(config.whatsapp.accessToken);

  const publisher = new InstagramPublisher(igGraph, db, config.instagram.accountId, config.instagram.dailyPublishLimit);
  const messaging = new InstagramMessaging(igGraph, config.instagram.accountId);
  const whatsapp = new WhatsAppClient(waGraph, config.whatsapp.phoneNumberId);

  const queue = new JobQueue(db);
  registerHandlers({ config, db, queue, publisher, messaging, whatsapp });

  return { config, db, queue, publisher, messaging, whatsapp };
}

function registerHandlers(app: App): void {
  const { db, queue, publisher, messaging, whatsapp, config } = app;

  queue.register("instagram.publish", async (payload) => {
    const postId = Number(payload.postId);
    const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId) as
      | { id: number; idempotency_key: string; kind: string; caption: string | null; media: string }
      | undefined;
    if (!post) throw Object.assign(new Error(`post ${postId} not found`), { retryable: false });

    await publisher.publish({
      idempotencyKey: post.idempotency_key,
      kind: post.kind as "image" | "carousel" | "reel" | "story",
      caption: post.caption ?? undefined,
      media: JSON.parse(post.media) as string[],
    });
  });

  /**
   * The comment-to-DM step. It asks for consent in plain words instead of assuming it: the
   * lead has to answer before anything reaches WhatsApp. That single question is the
   * difference between a pipeline that scales and a number that gets reported as spam.
   */
  queue.register("instagram.reply_dm", async (payload) => {
    const leadId = Number(payload.leadId);
    const commentId = String(payload.commentId);
    const lead = getLead(db, leadId);
    if (!lead) return;

    await messaging.privateReply(
      commentId,
      "Thanks for asking! Happy to send the details on WhatsApp. Reply with your number and the word YES and I'll send it over, or just tell me here if you prefer."
    );
    setStage(db, leadId, "contacted");
    audit(db, { actor: "system", action: "instagram.private_reply", subject: String(leadId), detail: { commentId } });
  });

  queue.register("lead.route", async (payload) => {
    const lead = getLead(db, Number(payload.leadId));
    if (!lead) return;
    // Routing is intentionally simple and visible: anything qualified with a phone number
    // and consent goes to WhatsApp, everything else waits for a human in the dashboard.
    if (lead.score >= 40 && lead.phone && lead.consent !== "none") {
      queue.enqueue("whatsapp.send", { leadId: lead.id });
    }
  });

  queue.register("whatsapp.send", async (payload) => {
    await sendToLead(
      db,
      whatsapp,
      {
        leadId: Number(payload.leadId),
        body: payload.body ? String(payload.body) : undefined,
        template: payload.template ? String(payload.template) : undefined,
        templateParameters: (payload.templateParameters as string[]) ?? [],
      },
      { template: config.whatsapp.reengagementTemplate, language: config.whatsapp.templateLanguage }
    );
  });

  queue.register("whatsapp.handle_inbound", async (payload) => {
    const lead = getLead(db, Number(payload.leadId));
    if (!lead) return;
    // Inside the service window a human can answer freely; the job's only role is to make
    // sure the conversation is visible and marked as live.
    setStage(db, lead.id, lead.stage === "new" ? "replied" : lead.stage);
  });

  queue.register("whatsapp.confirm_opt_out", async (payload) => {
    const lead = getLead(db, Number(payload.leadId));
    if (!lead?.phone) return;
    // Confirming an opt-out is allowed and expected: it closes the loop and proves the
    // request was honoured. It is the last message this contact ever receives.
    await whatsapp.sendText(lead.phone, "Understood, you will not receive any further messages from us. Thank you.");
  });
}
