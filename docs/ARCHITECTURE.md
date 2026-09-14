# Architecture

```
                    ┌──────────────────────────────────────────┐
   content source   │                   n8n                    │   Slack / Telegram
   (Sheets, Notion) ├──► briefs, captions, approvals, reports ──┤──► approvals + daily report
                    └──────────────┬───────────────────────────┘
                                   │ HTTP + x-cascade-key
                    ┌──────────────▼───────────────────────────┐
                    │                cascade                   │
                    │  publisher · consent gate · window rules  │
                    │  queue · dedupe · audit · console         │
                    └───┬──────────────────────────┬───────────┘
                        │ Graph API                │ webhooks (signed)
              ┌─────────▼─────────┐      ┌─────────▼──────────┐
              │ Instagram Graph   │      │  Meta webhooks     │
              │ WhatsApp Cloud    │      │  comments, DMs,    │
              └───────────────────┘      │  messages, status  │
                                         └────────────────────┘
```

## Why a service at all, rather than pure n8n

n8n is excellent at the parts that change often and badly suited to the parts that must be
exactly right every time. Three examples from this pipeline:

1. **Publishing is a state machine, not a request.** Create container, poll status, publish,
   fetch permalink, and resume correctly if the process dies in the middle. Expressed as n8n
   nodes it is a fragile chain where a retry restarts at step one and posts twice.
2. **Consent is a rule, not a node.** Any workflow that can call the WhatsApp API directly
   can forget to check consent. Routing every send through one function means a new workflow
   cannot bypass it, and there is one place to audit.
3. **Webhooks need signature verification on raw bytes.** n8n gives you a parsed body. The
   signature is computed on the exact bytes Meta sent.

So: n8n orchestrates, this service enforces.

## Modules

| Path | Responsibility |
|---|---|
| `src/core/graph.ts` | Graph API client, retry classification by Meta error code, backoff with jitter |
| `src/core/queue.ts` | SQLite-backed job queue: retries, exponential backoff, dead letters kept for inspection |
| `src/core/db.ts` | Schema and audit log |
| `src/instagram/publisher.ts` | Container creation (image, carousel, reel, story), status polling, idempotency, daily quota |
| `src/instagram/messaging.ts` | Private reply to a comment, public reply, direct message |
| `src/whatsapp/session.ts` | The 24 hour window and opt-out detection. Pure functions, no I/O |
| `src/whatsapp/outreach.ts` | The only place that sends: consent gate, window decision, message row, audit entry |
| `src/leads/scoring.ts` | Explainable rules, each with a weight and a reason |
| `src/leads/store.ts` | Capture, dedupe, consent, opt-out, event claiming |
| `src/webhooks/` | Signature and subscription verification, payload routing |
| `src/server.ts` | HTTP surface for n8n and the console |

## Data model

Seven tables. The ones that carry the design:

- **leads** — `consent`, `consent_source`, `consent_at`, `opted_out_at`, `last_inbound_at`.
  The last one is the 24 hour window; the other four are the compliance story.
- **processed_events** — one row per provider event id. Meta retries; we do not repeat.
- **posts** — `idempotency_key` unique, plus `container_id` so a resumed publish picks up the
  container it already created instead of making a second one.
- **messages** — written before sending, updated with the provider id, then updated again by
  the delivery-status webhook. A crash mid-send leaves evidence.
- **jobs** — pending / running / done / dead. Dead rows stay.
- **audit_log** — every consent change, every send, every refusal to send.

## Failure behaviour

| Failure | Behaviour |
|---|---|
| Graph API 429 or error code 4 / 80007 | Retry with exponential backoff and jitter, up to 4 attempts |
| Expired token (190) or bad parameter (100) | No retry; the job is dead-lettered and shows on the console |
| Reel still transcoding after 20 checks | Retryable failure; the container stays valid for 24 hours |
| WhatsApp 131047 (outside window) | The stored window is cleared so the next attempt uses a template |
| WhatsApp 131026 (unreachable) | The lead is opted out rather than retried |
| Webhook with a bad signature | 403, and the attempt is written to the audit log |
| Duplicate webhook delivery | Silently ignored after the first |

## Deployment shape

One Node process and one SQLite file behind a TLS terminator, plus n8n (self-hosted or cloud).
SQLite is a deliberate choice at this scale: a few thousand leads and a few hundred messages a
day fit comfortably, and one file is one backup. The data layer is behind `src/core/db.ts`, so
moving to Postgres when volume demands it is a contained change rather than a rewrite.
