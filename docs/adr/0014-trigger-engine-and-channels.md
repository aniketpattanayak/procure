# ADR-0014 One trigger engine for PDF, email, WhatsApp, in-app and webhooks

Status: accepted (Phases 4/6/7)

Templates (Handlebars, fixed helpers) render from a standard document context; PDFs render in the worker with network-locked headless Chromium. Trigger rules consume the Phase 3 outbox events; every send is a queued job with a unique idempotency key and passes the plan quota check first. Providers sit behind adapters (SES/SMTP, Meta/BSP) with a log driver for dev/test so nothing real is sent outside production.
