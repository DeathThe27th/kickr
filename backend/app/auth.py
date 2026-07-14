"""Auth (build.md §7): verify Privy access tokens (JWT via Privy JWKS) on all
/me and /bets routes; upsert user on first verified request.

When PRIVY_APP_ID is unset (zero-credential demo mode) a dev fallback accepts
`Authorization: Bearer dev:<handle>` so the full product remains demoable.
The real Privy path is unchanged and used whenever PRIVY_APP_ID is set.
"""
from __future__ import annotations

import logging

import jwt
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .config import settings
from .db import get_session
from .ledger import ensure_user
from .models import User

log = logging.getLogger("kickr.auth")

_jwks_client: jwt.PyJWKClient | None = None


def _verify_privy(token: str) -> dict:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = jwt.PyJWKClient(
            f"https://auth.privy.io/api/v1/apps/{settings.privy_app_id}/jwks.json",
            cache_keys=True,
        )
    key = _jwks_client.get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        key.key,
        algorithms=["ES256"],
        audience=settings.privy_app_id,
        issuer="privy.io",
    )


def current_user(request: Request, session: Session = Depends(get_session)) -> User:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    token = header[len("Bearer ") :].strip()

    if settings.privy_app_id:
        try:
            claims = _verify_privy(token)
        except Exception as exc:
            raise HTTPException(401, f"invalid token: {exc}") from exc
        did = claims["sub"]
        handle = did.split(":")[-1][:12]
    elif token.startswith("dev:") and settings.demo_mode:
        did = token
        handle = token[len("dev:") :][:32] or "guest"
    else:
        raise HTTPException(401, "auth not configured (set PRIVY_APP_ID) and token is not a dev token")

    user = ensure_user(session, did, handle)
    session.flush()
    return user
