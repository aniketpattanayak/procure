# ADR-0012 Transactional outbox and BullMQ

Status: accepted (Phase 3)

Business transactions write domain events to `app.outbox_event`; a relay job publishes them to BullMQ. Nothing is
sent for a rolled-back transaction, and consumers (Phase 6 trigger engine, webhooks) get at-least-once delivery
with `jobId = outbox:<id>` de-duplication. Background work (SLA scans, audit verification, imports/exports later,
PDF, email, WhatsApp) runs as BullMQ processors registered by modules through `QueueService`; the worker process
(`dist/worker.js`) runs them in production, the API runs them inline in development/test (`RUN_WORKERS`).
This supersedes ADR-0007's synchronous import note once imports move to jobs.
