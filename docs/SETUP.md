# Setup

About 45 minutes, most of it spent in the Meta dashboard.

## 1. Prerequisites

- An Instagram **professional** account (business or creator) linked to a Facebook Page.
- A Meta app with the Instagram Graph API and WhatsApp products added.
- A WhatsApp Business Account with a phone number registered on the Cloud API.
- A host with a public HTTPS URL (webhooks will not accept plain HTTP).
- Node 22 or newer.

## 2. Permissions to request

For Instagram publishing and comment handling:
`instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`,
`instagram_manage_messages`, `pages_show_list`, `pages_read_engagement`.

For WhatsApp: `whatsapp_business_messaging`, `whatsapp_business_management`.

Until the app passes App Review, these work only for users with a role on the app, which is
enough to build and test the whole pipeline.

## 3. Values for `.env`

| Variable | Where it comes from |
|---|---|
| `META_APP_SECRET` | App dashboard → Settings → Basic → App secret |
| `META_VERIFY_TOKEN` | Any random string you invent; you type the same one into the webhook screen |
| `IG_ACCOUNT_ID` | `GET /me/accounts` → the page, then `?fields=instagram_business_account` |
| `IG_ACCESS_TOKEN` | A long-lived page access token (exchange the short-lived one, then refresh before 60 days) |
| `WA_PHONE_NUMBER_ID` | WhatsApp → API setup → Phone number ID (not the phone number itself) |
| `WA_ACCESS_TOKEN` | A system user token with the WhatsApp permissions; the temporary one expires in 24 hours |
| `CASCADE_API_KEY` | `openssl rand -hex 32` |

Token expiry is the single most common cause of a pipeline that "just stopped": a 24-hour
token was used in production. Use a system user token and put its expiry in a calendar.

## 4. Webhooks

In the Meta app dashboard, for **both** products, set:

- Callback URL: `https://your-host/webhooks/instagram` and `https://your-host/webhooks/whatsapp`
- Verify token: the value of `META_VERIFY_TOKEN`
- Instagram fields: `comments`, `messages`
- WhatsApp fields: `messages`

Meta calls the URL with a challenge; this service answers it automatically once the token
matches. If verification fails, the reason is in the response body rather than in a log
somewhere.

## 5. Message templates

Create at least one template in the WhatsApp Manager, in the **utility** category for
follow-ups. The default name expected by `.env` is `lead_follow_up`, with one body parameter
for the contact's first name. Approval usually takes minutes but can take a day; marketing
templates are reviewed more strictly and are subject to per-user frequency limits.

## 6. Start and verify

```bash
npm install
npm test
npm start
curl https://your-host/health
```

`/health` reports the lead counts, the remaining Instagram quota for the day, and the number
of pending and dead jobs. If `jobsDead` is above zero, the console's audit tab says why.

## 7. n8n

Import the three workflows from `workflows/` and set these n8n environment variables:
`CASCADE_URL`, `CASCADE_API_KEY`, `CONTENT_SOURCE_URL`, `LLM_ENDPOINT`, `LLM_API_KEY`,
`LLM_MODEL`, `APPROVAL_WEBHOOK_URL`, `REPORT_WEBHOOK_URL`, `DEFAULT_COUNTRY_CODE`.

Run workflow 01 once by hand. It should produce a draft in the console and an approval
message wherever `APPROVAL_WEBHOOK_URL` points. Nothing publishes until a human approves.
