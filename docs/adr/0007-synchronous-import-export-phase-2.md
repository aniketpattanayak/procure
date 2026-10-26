# ADR-0007 Synchronous import/export until queues land

Status: accepted (Phase 2), revisit in Phase 3

Master import (≤ 5,000 rows, ≤ 5 MB) and export run synchronously in Phase 2 with a dry-run validation report and
all-or-nothing commit. Phase 3 introduces BullMQ for workflow SLAs; imports/exports above the cap and all report
exports then move to background jobs with a notification when ready. The API shape (`ImportReport`) stays.
