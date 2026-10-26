# ADR-0004 Access and refresh tokens

Status: accepted

15-minute HS256 access JWT held in memory by the web app; opaque 256-bit refresh token in an httpOnly,
SameSite=Strict cookie scoped to `/api/v1/auth`, stored as sha256 in `platform.auth_session`. Rotation on
every refresh; presenting a rotated token revokes the family. Force-logout writes the session id to a Redis
revocation set for one access-token lifetime so it takes effect immediately. Argon2id for passwords.
