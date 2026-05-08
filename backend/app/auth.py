"""Bearer-token authentication backed by SQLite.

Two storage backends are supported and selected at runtime:

* **Turso (libSQL) remote** — active when ``TURSO_DATABASE_URL`` and
  ``TURSO_AUTH_TOKEN`` are set. Each query is issued over HTTPS to a
  managed libSQL database in the cloud, so token data persists across
  ephemeral container restarts (Render free tier, etc.).
* **Local SQLite file** — fallback when the Turso env vars are absent.
  The DB lives at ``$WDE_DB_PATH`` (default ``/data/tokens.sqlite``)
  which still works for VMs with a persistent volume (e.g. Fly.io).

Tokens are random opaque strings issued by an admin via the admin
endpoints (see app.admin) and validated on every protected request
via the `require_token` FastAPI dependency.
"""

from __future__ import annotations

import os
import re
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from fastapi import Depends, Header, HTTPException, status

try:  # libsql is optional; we fall back to local sqlite when absent.
    import libsql  # type: ignore
except ImportError:  # pragma: no cover - exercised only when the package is missing
    libsql = None  # type: ignore

DB_PATH = Path(os.environ.get("WDE_DB_PATH", "/data/tokens.sqlite"))
TURSO_URL = os.environ.get("TURSO_DATABASE_URL", "").strip()
TURSO_AUTH = os.environ.get("TURSO_AUTH_TOKEN", "").strip()
USE_TURSO = bool(TURSO_URL and TURSO_AUTH and libsql is not None)

TOKEN_PREFIX = "wde_"
ALLOWED_DAYS = (1, 7, 30)

# Custom (admin-supplied) tokens: 6–64 chars from [A-Za-z0-9_-].
CUSTOM_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")

_lock = threading.Lock()
_admin_secret_cache: str | None = None


def _ensure_dir() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def _connect() -> Any:
    if USE_TURSO:
        # libsql.connect returns a sqlite3-like Connection that proxies to
        # the Turso/libSQL HTTPS endpoint.
        return libsql.connect(database=TURSO_URL, auth_token=TURSO_AUTH)
    _ensure_dir()
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """Create the tokens table on first run. Safe to call repeatedly."""
    with db_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tokens (
                token       TEXT PRIMARY KEY,
                label       TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                expires_at  TEXT NOT NULL,
                revoked     INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.commit()


@contextmanager
def db_conn() -> Iterator[Any]:
    """Yield a DB connection (libsql or sqlite3) under the global lock."""
    with _lock:
        conn = _connect()
        try:
            yield conn
        finally:
            try:
                conn.close()
            except Exception:
                pass


@dataclass
class TokenRecord:
    token: str
    label: str
    created_at: str
    expires_at: str
    revoked: bool

    @classmethod
    def from_row(cls, row: Any) -> "TokenRecord":
        # Both sqlite3 (with default row_factory) and libsql return tuples
        # in column order. SELECTs in this module always project the same
        # five columns in the same order, so positional access is safe.
        return cls(
            token=row[0],
            label=row[1],
            created_at=row[2],
            expires_at=row[3],
            revoked=bool(row[4]),
        )

    def is_expired(self, now: datetime | None = None) -> bool:
        now = now or datetime.now(timezone.utc)
        try:
            exp = datetime.fromisoformat(self.expires_at)
        except ValueError:
            return True
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        return now >= exp

    def to_public(self) -> dict:
        return {
            "label": self.label,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "revoked": self.revoked,
            "expired": self.is_expired(),
        }

    def to_admin(self) -> dict:
        d = self.to_public()
        d["token"] = self.token
        return d


def create_token(label: str, days: int, custom_token: str | None = None) -> TokenRecord:
    if days not in ALLOWED_DAYS:
        raise ValueError(f"days must be one of {ALLOWED_DAYS}")
    label = (label or "").strip()
    if not label:
        raise ValueError("label is required")

    if custom_token is not None:
        custom_token = custom_token.strip()
        if not CUSTOM_TOKEN_RE.match(custom_token):
            raise ValueError(
                "Custom token must be 6–64 characters of letters, digits, '-' or '_'"
            )
        token = custom_token
    else:
        token = TOKEN_PREFIX + secrets.token_urlsafe(24)

    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=days)
    rec = TokenRecord(
        token=token,
        label=label,
        created_at=now.isoformat(timespec="seconds"),
        expires_at=expires.isoformat(timespec="seconds"),
        revoked=False,
    )
    with db_conn() as conn:
        # libsql doesn't expose IntegrityError consistently, so do an
        # explicit existence check first. The race window is acceptable
        # because token creation is admin-only.
        cur = conn.execute(
            "SELECT 1 FROM tokens WHERE token = ?", (rec.token,)
        )
        if cur.fetchone() is not None:
            raise ValueError("Token already exists; pick a different value")
        try:
            conn.execute(
                "INSERT INTO tokens(token, label, created_at, expires_at, revoked)"
                " VALUES (?, ?, ?, ?, 0)",
                (rec.token, rec.label, rec.created_at, rec.expires_at),
            )
            conn.commit()
        except sqlite3.IntegrityError as exc:
            raise ValueError("Token already exists; pick a different value") from exc
        except Exception as exc:  # libsql-specific errors land here
            msg = str(exc).lower()
            if "unique" in msg or "primary key" in msg:
                raise ValueError("Token already exists; pick a different value") from exc
            raise
    return rec


def list_tokens() -> list[TokenRecord]:
    with db_conn() as conn:
        cur = conn.execute(
            "SELECT token, label, created_at, expires_at, revoked"
            " FROM tokens ORDER BY created_at DESC"
        )
        return [TokenRecord.from_row(r) for r in cur.fetchall()]


def get_token(token: str) -> TokenRecord | None:
    with db_conn() as conn:
        cur = conn.execute(
            "SELECT token, label, created_at, expires_at, revoked"
            " FROM tokens WHERE token = ?",
            (token,),
        )
        row = cur.fetchone()
    return TokenRecord.from_row(row) if row else None


def revoke_token(token: str) -> bool:
    with db_conn() as conn:
        cur = conn.execute("UPDATE tokens SET revoked = 1 WHERE token = ?", (token,))
        conn.commit()
        return cur.rowcount > 0


def _extract_bearer(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must be 'Bearer <token>'",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return parts[1].strip()


def require_token(authorization: str | None = Header(default=None)) -> TokenRecord:
    """FastAPI dependency: 401 unless a valid, non-revoked, non-expired token is supplied."""
    token = _extract_bearer(authorization)
    rec = get_token(token)
    if rec is None or rec.revoked or rec.is_expired():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return rec


def _read_admin_secret() -> str:
    """Resolve the admin secret in this priority order:

    1. ``ADMIN_SECRET`` environment variable (preferred — Fly secrets).
    2. ``$WDE_DB_PATH/../admin_secret.txt`` (auto-generated on first boot
       and persisted on the volume).
    3. ``app/admin_secret.txt`` shipped in the image (fallback for
       single-tenant private deployments where rotating the env var is
       inconvenient — generated by the deployer before build).

    If none are present, a strong random secret is generated and
    persisted alongside the SQLite DB so the server is always usable;
    the value is logged once at startup so the operator can see it via
    `fly logs`.
    """
    global _admin_secret_cache
    if _admin_secret_cache:
        return _admin_secret_cache
    s = os.environ.get("ADMIN_SECRET", "").strip()
    if s:
        _admin_secret_cache = s
        return s
    persistent = DB_PATH.parent / "admin_secret.txt"
    if persistent.exists():
        try:
            v = persistent.read_text().strip()
            if v:
                _admin_secret_cache = v
                return v
        except OSError:
            pass
    shipped = Path(__file__).parent / "admin_secret.txt"
    if shipped.exists():
        try:
            v = shipped.read_text().strip()
            if v:
                _admin_secret_cache = v
                return v
        except OSError:
            pass
    # Generate-on-first-boot. Persist next to the SQLite DB. Cache so a
    # write failure does not produce a different secret on every call —
    # otherwise the value logged at startup would never validate.
    _ensure_dir()
    new_secret = secrets.token_urlsafe(32)
    _admin_secret_cache = new_secret
    try:
        persistent.write_text(new_secret)
        # Be loud so the operator can fish it out of `fly logs`.
        print(
            f"[auth] generated new ADMIN_SECRET and stored at {persistent}: "
            f"{new_secret}",
            flush=True,
        )
    except OSError as exc:
        print(
            f"[auth] failed to persist admin secret (cached in memory only): {exc}",
            flush=True,
        )
    return new_secret


def require_admin(x_admin_secret: str | None = Header(default=None)) -> None:
    expected = _read_admin_secret()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Server is missing ADMIN_SECRET configuration",
        )
    if not x_admin_secret or not secrets.compare_digest(x_admin_secret, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid X-Admin-Secret",
        )


# Convenience for endpoints that just need the dep wired up.
RequireToken = Depends(require_token)
RequireAdmin = Depends(require_admin)
