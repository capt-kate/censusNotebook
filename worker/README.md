# Census Notebook License Worker

This Cloudflare Worker receives Stripe payment webhooks and updates the Census Notebook license database.

## What You Need From Cloudflare

In `worker/wrangler.toml`, replace:

- `database_name`
- `database_id`

The D1 binding must be named `DB`.

## What You Need From Stripe

In `worker/wrangler.toml`, replace the three Payment Link IDs:

- `STRIPE_PRO_PAYMENT_LINK_ID`
- `STRIPE_EXTRA_PROJECT_PAYMENT_LINK_ID`
- `STRIPE_COFFEE_PAYMENT_LINK_ID`

Use the Stripe Payment Link IDs, not the full checkout URLs. They usually begin with `plink_`.

Then add your webhook signing secret:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

The secret starts with `whsec_`.

## Stripe Webhook Endpoint

In Stripe, create a webhook endpoint:

```text
https://YOUR-WORKER.workers.dev/stripe/webhook
```

Subscribe to:

```text
checkout.session.completed
```

## Deploy

From this folder:

```bash
cd /Users/Kate/census-notebook/worker
npx wrangler deploy
```

## Test Endpoints

Health check:

```text
https://YOUR-WORKER.workers.dev/health
```

License lookup:

```text
https://YOUR-WORKER.workers.dev/license/status?email=customer@example.com
```

or:

```text
https://YOUR-WORKER.workers.dev/license/status?licenseKey=CN-XXXX-XXXX-XXXX
```

## Notes

- Pro purchases set `plan` to `pro`.
- Extra project purchases increment `extra_project_slots`.
- Buy Me a Coffee records the purchase but does not change the license.
- The Worker verifies Stripe signatures using the raw request body.
