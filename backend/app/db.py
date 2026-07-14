"""Database engine/session. SQLite by default (demo mode, zero credentials);
point DATABASE_URL at Supabase Postgres in production. The canonical Postgres
schema lives in backend/migrations/001_init.sql; for SQLite we create the same
tables from the ORM metadata."""
from __future__ import annotations

from contextlib import contextmanager

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Base

_connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=_connect_args)

if settings.database_url.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _):  # noqa: ANN001
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def init_db() -> None:
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        # `balances` view mirrors the Postgres migration (balance = SUM(amount)).
        # Postgres has no CREATE VIEW IF NOT EXISTS — use CREATE OR REPLACE there.
        verb = "CREATE VIEW IF NOT EXISTS" if engine.dialect.name == "sqlite" else "CREATE OR REPLACE VIEW"
        conn.execute(
            text(
                f"{verb} balances AS "
                "SELECT user_id, COALESCE(SUM(amount), 0) AS balance "
                "FROM transactions GROUP BY user_id"
            )
        )


@contextmanager
def session_scope() -> Session:
    """One transaction per unit of work; money paths rely on this."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session():
    """FastAPI dependency."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
