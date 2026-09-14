# Compliance notes

This is the part of the project that matters most, and the part most automations skip.

## What gets an account or a number killed

**Instagram.** The Graph API is the only supported way to publish and to read comments and
DMs for a professional account. Anything that drives the mobile or web client through an
unofficial library is a terms-of-service breach, and the enforcement is not a warning: the
account loses publishing access, sometimes permanently. Rate limits are real too, and the
publishing cap of 50 posts per 24 hours per account is enforced on Meta's side.

**WhatsApp.** The Business Platform is built around one rule: a business may message a
person who has opted in, and may only speak freely for 24 hours after that person's last
message. Outside that window, only a pre-approved template. Beyond the rule there is a
quality rating, driven largely by block and report rates, and it controls the daily messaging
limit. A number that gets reported drops to a lower tier, then gets restricted. Buying a list
and messaging it is the standard way to destroy a number in a week.

**Data protection.** A phone number and an Instagram handle are personal data. Under GDPR
that means a lawful basis for processing, a record of consent, the ability to show it, and
the ability to delete it on request. Under most other regimes it means something close.

## What Cascade does about each

| Rule | Mechanism |
|---|---|
| Official APIs only | Graph API and WhatsApp Cloud API; no browser automation anywhere in the codebase |
| Publishing cap | `InstagramPublisher.quotaRemaining()` checked before each publish |
| Consent before WhatsApp | `leads.consent` (`none` / `inbound_message` / `explicit`) plus `consent_source` and `consent_at`, checked in `sendToLead` |
| 24 hour window | `decideSend()` returns free-form, template, or refusal, with the reason recorded |
| Opt-out | Detected on every inbound message, honoured immediately, confirmed once, never overridden |
| Right to be forgotten | Every lead row is deletable by id; the audit log keeps the action, not the content |
| Proof of consent | `audit_log` records who consented, from where, and when |

## The consent flow that makes this work

A public comment is intent, not permission. The flow is:

1. Somebody comments "how much?" on a post.
2. Cascade scores the comment and, if it qualifies, sends **one private reply** to that
   comment (the Instagram private-reply endpoint allows exactly one, within 7 days).
3. That reply asks, in plain words, for a number and a yes.
4. Only when the person answers is consent recorded, with its source, and only then can a
   WhatsApp message be sent.

It converts worse than blasting everybody who ever liked a post. It also still works in month
six, which blasting does not.

## What is deliberately not built

- follower, hashtag or competitor-audience scraping
- automation of personal accounts
- bulk sending to purchased lists
- any attempt to evade rate limits through multiple accounts or numbers

If a client needs those, this is the wrong codebase and, more usefully, the wrong plan.
