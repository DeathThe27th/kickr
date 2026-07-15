/** Shared API shapes. */

export type FixtureT = {
  id: string;
  txline_fixture_id: number;
  stage: string;
  bracket_slot: string | null;
  home: string;
  away: string;
  kickoff_at: string;
  status: string;
  /** live = the real TxLINE feed; demo = a simulated match. Both can run at once. */
  source: "live" | "demo";
  score: [number, number];
  minute: number;
  win_probs: Record<string, number> | null;
  open_markets: number;
};

// Mirrors app/txline/simulator.py — a demo fixture's id is derived from the
// real one it was cloned from, which is how a running demo is matched back to
// its source fixture in the picker.
export const DEMO_ID_BASE = 900_000_000;

export function demoIdFor(realTxlineId: number): number {
  return DEMO_ID_BASE + (realTxlineId % 100_000_000);
}

export function isDemoId(txlineFixtureId: number): boolean {
  return txlineFixtureId >= DEMO_ID_BASE;
}
