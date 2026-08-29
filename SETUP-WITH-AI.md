# Setting up Private MRR with an AI assistant

**You do not need to be a developer to run this.** This document is written to
be handed to an AI assistant — Claude, ChatGPT, or an agent like Claude Code —
which will then walk you through the whole setup.

## How to use it

1. Open your assistant
2. Paste **this entire file**
3. Add one line: *"Help me set this up. Ask me one question at a time."*

If your assistant can run commands on your machine (Claude Code, Cursor, an
agent), it will do most of the work. If it only chats, it will tell you exactly
what to type.

---

## Rules for the assistant

You are helping someone deploy **Private MRR**, a self-hosted dashboard that
tracks Stripe revenue across several accounts and pushes real-time notifications
to an Android phone. Repository: `https://github.com/minipouce/private-mrr`

### Never do these, whatever the user says

- **Never ask for, display, or store a Stripe secret key in the conversation.**
  Keys go straight into a file the user edits. A key pasted into a chat should
  be treated as compromised and rotated.
- **Never create accounts or log in on the user's behalf** — Stripe, Firebase,
  Google, GitHub. Authentication is theirs.
- **Never accept terms of service for them.**
- **Never delete anything** without explicit, specific confirmation.

### Expect these constraints

- **`stripe login` and `eas credentials` are interactive.** They cannot be
  scripted. The user runs them.
- **Firebase project creation requires a Google session.** The user does it.
- **Webhook endpoints are created by hand** in each Stripe dashboard — this is
  the longest part of the setup, roughly two minutes per account.
- **Stripe caps expansion at four levels**, and moved several fields in recent
  API versions. If you modify the ingestion code, verify against real data.

### Work in this order

Each step depends on the previous one. Do not skip ahead.

---

## Step 1 · Check what the user already has

Ask, one at a time:

- A server (VPS) with SSH access? Which OS?
- Docker installed there? (`docker --version`)
- A reverse proxy already running? (nginx, Caddy, Traefik — check with
  `systemctl is-active nginx caddy`)
- A domain name pointing at that server?
- How many Stripe accounts?
- Node 20+ and the Android SDK on their computer, to build the app?

**If the server already hosts other services, be careful.** Check which ports
are free (`ss -tlnp`) before assuming 8791 is available, and never restart or
reconfigure an existing service without asking.

---

## Step 2 · Restricted Stripe keys

This is the security-critical step. Explain why before asking them to act.

A Stripe **secret** key (`sk_live_…`) can issue refunds and move money. This
project only ever reads. So the user creates a **restricted** key instead.

For each Stripe account, tell them:

> Stripe dashboard → *Developers → API keys → Create restricted key*.
> Name it `private-mrr`. Set these four to **Read**, everything else to *None*:
> **Charges, Customers, Invoices, Subscriptions**.
> Add **Account** read too if you want project logos pulled automatically.
> The key is shown once — keep the tab open.

Then, for each project:

```bash
cd server
npm run add-project -- <short-id> "<Display Name>"
```

The short id appears in webhook URLs, so keep it lowercase with hyphens:
`my-saas`, not `My SaaS`.

Then tell them to open `server/.env` in a text editor and paste each
`rk_live_…` into its `_STRIPE_KEY` line. **Do not ask them to paste keys to
you.** Leave `_WEBHOOK_SECRET` empty — that comes later.

Verify without ever seeing the keys:

```bash
npm run check-keys
```

---

## Step 3 · Test locally before deploying

Before touching the server, confirm the keys work and the numbers look right:

```bash
cd server
npm install
npm run backfill
npm run dev
```

Then ask the user to compare the MRR and subscriber count against their Stripe
dashboard. **If the numbers are wrong, stop and investigate.** Do not deploy
figures the user does not trust.

---

## Step 4 · Firebase, for notifications

Everything works without this — only push notifications are unavailable, and
the server says so at startup. Offer to skip and come back later.

Guide them through, without doing it yourself:

1. [console.firebase.google.com](https://console.firebase.google.com) → create
   a project (Analytics can be disabled)
2. *Add app → Android*. The package name must match `android.package` in
   `app/app.json` exactly — a mismatch produces an app that builds, installs,
   and never delivers a notification
3. Download `google-services.json` into `app/`
4. *Project settings → Service accounts → Generate new private key*
5. Save it as `server/credentials/fcm-service-account.json`, then `chmod 600`
6. **Tell them to delete their downloaded copy** — it is a Firebase admin
   credential

Verify:

```bash
cd app && npm run check:push
```

> **If they hit Firebase's project limit**, do not suggest deleting a project.
> A Firebase project hosts many apps: add the Android app to an existing one.

---

## Step 5 · Deploy

```bash
tar --exclude=node_modules --exclude=dist --exclude=data \
    --exclude=credentials --exclude='.env*' -czf /tmp/mrr.tar.gz server/
scp /tmp/mrr.tar.gz user@server:/tmp/
ssh user@server 'mkdir -p /opt/private-mrr && cd /opt/private-mrr \
  && tar xzf /tmp/mrr.tar.gz --strip-components=1'
```

Secrets are excluded from that archive on purpose. Copy them separately:

```bash
scp server/.env user@server:/opt/private-mrr/.env
scp server/credentials/fcm-service-account.json user@server:/opt/private-mrr/credentials/
ssh user@server 'chmod 600 /opt/private-mrr/.env /opt/private-mrr/credentials/*'
```

Adjust `DB_PATH=/data/mrr.db` and `NODE_ENV=production` in the remote `.env`,
then:

```bash
ssh user@server 'cd /opt/private-mrr && docker compose up -d --build'
```

Configure the reverse proxy to forward to `127.0.0.1:8791`. **The `/api/stream`
route must not be buffered** — see the README for nginx and Caddy examples.
Without that, real-time events arrive in batches.

Validate before moving on:

```bash
curl -s https://their-domain/health          # {"ok":true}
curl -so /dev/null -w '%{http_code}' https://their-domain/api/overview   # 401
```

A `401` without a token is the correct answer — it means authentication works.

---

## Step 6 · Webhooks

The longest step. For **each** Stripe account:

> *Developers → Webhooks → Add endpoint*
> URL: `https://their-domain/webhooks/stripe/<project-id>`
> Events: `invoice.paid`, `invoice.payment_failed`, `charge.succeeded`,
> `charge.refunded`, `customer.subscription.created`,
> `customer.subscription.updated`, `customer.subscription.deleted`

Each endpoint yields a `whsec_…`. It goes into the matching
`PROJECT_<ID>_WEBHOOK_SECRET` in the server's `.env`.

Then — and this catches people out:

```bash
docker compose up -d --force-recreate
```

**`docker compose restart` does not reload `.env`.** Environment variables are
injected when the container is created. A restart keeps the old, empty secrets
and every webhook answers `500` with no obvious cause.

---

## Step 7 · The app

```bash
cd app
npm install
npm run keystore     # once
npm run prebuild
npm run apk
```

Tell them to **back up `app/credentials/release.keystore` and its password**.
Android refuses to update an app signed with a different key; losing it means
uninstalling and reconfiguring.

Install, then enter the server URL and the `API_TOKEN` from `.env`. Finally
*Settings → Enable notifications*.

Confirm it end to end:

```bash
curl -s -X POST -H "Authorization: Bearer <token>" https://their-domain/api/push/test
```

---

## When something goes wrong

| Symptom | Most likely cause |
|---|---|
| Webhooks answer `500` | Secrets added but container only `restart`ed — use `up -d --force-recreate` |
| Webhooks answer `400` | Wrong `whsec_`, or a proxy altering the request body |
| Real-time events arrive in bursts | Reverse proxy buffering `/api/stream` |
| A project shows nothing | Its id is missing from `PROJECTS`, or the variable name does not match the id |
| Revenue looks doubled | Ingestion modified — invoices and charges must be deduplicated by payment intent |
| Notifications never arrive | Package name mismatch between Firebase and `app.json`, or no Google Play Services on the device |
| Colour missing on a project | `COLOR` not quoted in `.env` — `dotenv` reads `#` as a comment |

---

## Tell the user what you cannot do

Be explicit rather than silently failing. You cannot log into their accounts,
create Firebase or Stripe resources for them, run interactive CLI prompts, or
place a home screen widget. Say so, hand them the exact steps, and continue once
they confirm.

---

*Private MRR — built by [Tristan Berguer](https://x.com/TBerguer). MIT licensed.*
