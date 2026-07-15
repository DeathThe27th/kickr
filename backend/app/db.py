"""Database engine/session. SQLite by default (demo mode, zero credentials);
point DATABASE_URL at Supabase Postgres in production. The canonical Postgres
schema lives in backend/migrations/001_init.sql; for SQLite we create the same
tables from the ORM metadata."""
from __future__ import annotations

from contextlib import contextmanager

from sqlalchemy import create_engine, event, inspect, text
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


def _ensure_columns(conn) -> None:  # noqa: ANN001
    """create_all() creates missing *tables*, never missing columns.

    `fixtures.source` landed after the first deploy, so an existing Supabase
    database would keep the old shape and every query naming it would fail.
    Adding it in place keeps deploys a push rather than a manual ALTER, and is
    a no-op once applied.
    """
    if "fixtures" not in inspect(conn).get_table_names():
        return
    columns = {c["name"] for c in inspect(conn).get_columns("fixtures")}
    if "source" not in columns:
        conn.execute(text("ALTER TABLE fixtures ADD COLUMN source VARCHAR(8) NOT NULL DEFAULT 'live'"))


def init_db() -> None:
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        _ensure_columns(conn)
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
