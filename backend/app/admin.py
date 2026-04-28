"""Admin router: create / list / revoke tokens.

All routes are protected by `require_admin` which checks the
`X-Admin-Secret` header against the `ADMIN_SECRET` environment variable.

Also exposes a small CLI:
    python -m app.admin create-token --label "Andi" --days 7
    python -m app.admin list-tokens
    python -m app.admin revoke-token <token>
"""

from __future__ import annotations

import argparse
import sys

from fastapi import APIRouter, HTTPException

from . import auth

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.post("/tokens", dependencies=[auth.RequireAdmin])
def admin_create_token(payload: dict) -> dict:
    label = payload.get("label", "")
    days = payload.get("days")
    try:
        days_int = int(days)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="`days` must be an integer") from exc
    try:
        rec = auth.create_token(label=label, days=days_int)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return rec.to_admin()


@router.get("/tokens", dependencies=[auth.RequireAdmin])
def admin_list_tokens() -> dict:
    rows = [t.to_admin() for t in auth.list_tokens()]
    return {"count": len(rows), "tokens": rows}


@router.delete("/tokens/{token}", dependencies=[auth.RequireAdmin])
def admin_revoke_token(token: str) -> dict:
    ok = auth.revoke_token(token)
    if not ok:
        raise HTTPException(status_code=404, detail="Token not found")
    return {"revoked": True, "token": token}


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------


def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="app.admin")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_create = sub.add_parser("create-token", help="Create a new auth token")
    p_create.add_argument("--label", required=True, help="Human-readable label")
    p_create.add_argument(
        "--days",
        required=True,
        type=int,
        choices=auth.ALLOWED_DAYS,
        help="Token validity in days",
    )

    sub.add_parser("list-tokens", help="List all tokens")

    p_revoke = sub.add_parser("revoke-token", help="Revoke a token by id")
    p_revoke.add_argument("token", help="Full token string")

    args = parser.parse_args(argv)

    auth.init_db()

    if args.cmd == "create-token":
        rec = auth.create_token(label=args.label, days=args.days)
        print(rec.token)
        print(f"label:      {rec.label}")
        print(f"created_at: {rec.created_at}")
        print(f"expires_at: {rec.expires_at}")
        return 0
    if args.cmd == "list-tokens":
        rows = auth.list_tokens()
        if not rows:
            print("(no tokens)")
            return 0
        for t in rows:
            status_s = "revoked" if t.revoked else ("expired" if t.is_expired() else "active")
            print(f"[{status_s:7s}]  {t.token}  {t.label!r}  exp={t.expires_at}")
        return 0
    if args.cmd == "revoke-token":
        ok = auth.revoke_token(args.token)
        print("revoked" if ok else "not found")
        return 0 if ok else 1
    return 1


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
