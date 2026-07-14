"""Generate backend/fixtures/bracket_2026.json from the real TxLINE fixture
snapshots captured in backend/samples/ (build.md §8.2: 'Seed the bracket
structure from a static JSON of the 2026 knockout slots mapped to TxLINE
fixture IDs'). Re-run against fresh samples to refresh.

Stages are assigned by the real tournament calendar:
group <= Jun 27, r32 Jun 28-Jul 3, r16 Jul 4-8, qf Jul 9-13, sf Jul 14-16, f after.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
SAMPLES = BACKEND / "samples"
OUT = BACKEND / "fixtures" / "bracket_2026.json"

# FixtureGroupId in the real payloads identifies the tournament stage
# (verified against the actual 2026 calendar: 16 R32 games Jun 28-Jul 4, etc.)
STAGE_BY_GROUP_ID = {
    10115674: "group",
    10115677: "r32",
    10115574: "r16",
    10115675: "qf",
    10115573: "sf",
}

STAGE_WINDOWS = [  # date fallback for records with unknown FixtureGroupId
    ("group", datetime(2026, 6, 28, tzinfo=timezone.utc)),
    ("r32", datetime(2026, 7, 4, 12, tzinfo=timezone.utc)),
    ("r16", datetime(2026, 7, 9, tzinfo=timezone.utc)),
    ("qf", datetime(2026, 7, 13, tzinfo=timezone.utc)),
    ("sf", datetime(2026, 7, 17, tzinfo=timezone.utc)),
]


def stage_for(kickoff: datetime, group_id: int | None) -> str:
    if group_id in STAGE_BY_GROUP_ID:
        return STAGE_BY_GROUP_ID[group_id]
    for stage, before in STAGE_WINDOWS:
        if kickoff < before:
            return stage
    return "f"


def main() -> None:
    fixtures: dict[int, dict] = {}
    for f in sorted(SAMPLES.glob("fixtures_snapshot_day*.json")):
        for raw in json.loads(f.read_text()):
            p1_home = raw.get("Participant1IsHome", True)
            kickoff = datetime.fromtimestamp(raw["StartTime"] / 1000, tz=timezone.utc)
            fixtures[raw["FixtureId"]] = {
                "txline_fixture_id": raw["FixtureId"],
                "home": raw["Participant1"] if p1_home else raw["Participant2"],
                "away": raw["Participant2"] if p1_home else raw["Participant1"],
                "kickoff_at": kickoff.isoformat(),
                "stage": stage_for(kickoff, raw.get("FixtureGroupId")),
            }

    ordered = sorted(fixtures.values(), key=lambda x: x["kickoff_at"])
    counters: dict[str, int] = {}
    for fx in ordered:
        counters[fx["stage"]] = counters.get(fx["stage"], 0) + 1
        fx["bracket_slot"] = f"{fx['stage']}{counters[fx['stage']]}"

    # The final isn't in the feed until the semis finish — placeholder slot.
    if not any(fx["stage"] == "f" for fx in ordered):
        ordered.append(
            {
                "txline_fixture_id": 99999901,
                "home": "Winner SF1",
                "away": "Winner SF2",
                "kickoff_at": "2026-07-19T19:00:00+00:00",
                "stage": "f",
                "bracket_slot": "f1",
            }
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"generated_at": datetime.now(timezone.utc).isoformat(), "fixtures": ordered}, indent=1))
    by_stage = {}
    for fx in ordered:
        by_stage[fx["stage"]] = by_stage.get(fx["stage"], 0) + 1
    print(f"Wrote {len(ordered)} fixtures to {OUT}: {by_stage}")


if __name__ == "__main__":
    main()
