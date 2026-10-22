# Cloudflare Worker migration

This folder contains the Cloudflare Workers version of the LINE webhook.

Required secrets:
- GEMINI_API_KEY
- CHANNEL_SECRET
- CHANNEL_ACCESS_TOKEN

Optional variable:
- GEMINI_MODELS (comma-separated fallback order)

Endpoints:
- GET /health
- POST /callback
- POST /webhook

This first migration step intentionally does not write tasks to the database yet. It is for validating:
LINE -> Cloudflare Worker -> Gemini -> LINE reply

After this path is stable, add durable idempotency, queueing and task persistence.
