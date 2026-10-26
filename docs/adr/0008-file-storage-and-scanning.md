# ADR-0008 File storage, signed URLs and scanning

Status: accepted (Phase 2)

Bytes live behind a `StorageDriver` (`local` for dev/test, `s3` for staging/prod); `app.file_object` is the catalogue.
MIME is sniffed from content. Files start `pending` and are served only when `clean`; the `noop` scanner marks clean
immediately in dev/test, `clamav` scans in prod. Download URLs are signed and expire in 5 minutes (HMAC for local,
S3 presign for s3). Storage usage is metered in bytes against the plan's GB limit via `app.consume_storage`.
