"""Central configuration: environment variables + economy constants (build.md §5, §10)."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Infrastructure ---
    database_url: str = "sqlite:///./kickr.db"  # Supabase Postgres in prod
    txline_api_origin: str = "https://txline-dev.txodds.com"
    txline_jwt: str = ""
    txline_api_token: str = ""
    privy_app_id: str = ""
    solana_rpc: str = "https://api.devnet.solana.com"
    solana_keypair: str = ""  # base58 secret key
    demo_mode: bool = True
    admin_key: str = "kickr-dev-admin"
    margin: float = 0.05

    # --- Economy (build.md §5) ---
    signup_bonus: int = 1_000
    faucet_amount: int = 200
    bust_reset_to: int = 100
    bust_reset_threshold: int = 10
    max_stake: int = 500
    max_market_exposure: int = 20_000
    quote_tolerance: float = 0.02  # accepted odds drift between client quote and current

    # --- Pricing (build.md §3) ---
    odds_floor: float = 1.05
    odds_cap: float = 15.0
    staleness_seconds: int = 90
    stoppage_allowance_min: int = 4  # flat +4 after minute 80

    # --- Markets (build.md §4) ---
    max_micro_markets_open: int = 4

    # --- Demo replay (build.md §9) ---
    demo_speed: float = 15.0  # 90 match minutes compressed into 6 wall minutes
    demo_file: str = "fixtures/demo_match.jsonl"

    # World Cup competition id observed in the real devnet payloads (backend/samples/)
    txline_competition_id: int = 72


settings = Settings()
