"use client";

/** The 2026 knockout tree (§8.2): R32 → R16 → QF → SF → F columns,
 * horizontally scrollable on mobile. Node states: upcoming (kickoff + fav %),
 * live (yellow fill, pulse, score+minute), finished (dimmed, final score). */

import React from "react";
import { LivePill } from "./shared";

export type FixtureT = {
  id: string;
  txline_fixture_id: number;
  stage: string;
  bracket_slot: string | null;
  home: string;
  away: string;
  kickoff_at: string;
  status: string;
  score: [number, number];
  minute: number;
  win_probs: Record<string, number> | null;
  open_markets: number;
};

const STAGES: { key: string; label: string }[] = [
  { key: "r32", label: "Round of 32" },
  { key: "r16", label: "Round of 16" },
  { key: "qf", label: "Quarter-finals" },
  { key: "sf", label: "Semi-finals" },
  { key: "f", label: "Final" },
];

function favLine(f: FixtureT): string | null {
  if (!f.win_probs) return null;
  const home = f.win_probs.home ?? 0;
  const away = f.win_probs.away ?? 0;
  const fav = home >= away ? f.home : f.away;
  const p = Math.round(Math.max(home, away) * 100);
  return `${fav} ${p}%`;
}

function Node({ f, onOpen }: { f: FixtureT; onOpen: (f: FixtureT) => void }) {
  const live = f.status === "live";
  const finished = f.status === "finished";
  return (
    <button
      onClick={() => onOpen(f)}
      className={`w-52 shrink-0 rounded-xl border p-3 text-left transition-colors ${
        live
          ? "border-kickr-yellow-deep bg-kickr-yellow shadow-sm"
          : finished
            ? "border-kickr-line bg-white opacity-50"
            : "border-kickr-line bg-white hover:border-kickr-yellow-deep"
      }`}
    >
      <div className="flex items-center justify-between text-sm font-semibold">
        <span className="truncate">{f.home}</span>
        {(live || finished) && <span className="num">{f.score[0]}</span>}
      </div>
      <div className="mt-0.5 flex items-center justify-between text-sm font-semibold">
        <span className="truncate">{f.away}</span>
        {(live || finished) && <span className="num">{f.score[1]}</span>}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-kickr-ink/60">
        {live ? (
          <LivePill minute={f.minute} />
        ) : finished ? (
          <span>FT</span>
        ) : (
          <span className="num">
            {new Date(f.kickoff_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
            {new Date(f.kickoff_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        {!live && !finished && favLine(f) && <span className="truncate pl-1">{favLine(f)}</span>}
        {f.open_markets > 0 && (
          <span className={`num rounded-full px-1.5 ${live ? "bg-kickr-ink text-kickr-yellow" : "bg-kickr-yellow/60"}`}>
            {f.open_markets}
          </span>
        )}
      </div>
    </button>
  );
}

export function Bracket({ fixtures, onOpen }: { fixtures: FixtureT[]; onOpen: (f: FixtureT) => void }) {
  return (
    <div className="overflow-x-auto pb-4">
      <div className="flex min-w-max gap-6">
        {STAGES.map((stage) => {
          const nodes = fixtures
            .filter((f) => f.stage === stage.key)
            .sort((a, b) => (a.bracket_slot ?? "").localeCompare(b.bracket_slot ?? "", undefined, { numeric: true }));
          if (nodes.length === 0) return null;
          return (
            <div key={stage.key} className="flex flex-col">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-kickr-ink/50">
                {stage.label}
              </h3>
              <div className="flex flex-1 flex-col justify-around gap-3">
                {nodes.map((f) => (
                  <Node key={f.id} f={f} onOpen={onOpen} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function GroupList({ fixtures, onOpen }: { fixtures: FixtureT[]; onOpen: (f: FixtureT) => void }) {
  const groups = fixtures
    .filter((f) => f.stage === "group")
    .sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at));
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map((f) => (
        <Node key={f.id} f={f} onOpen={onOpen} />
      ))}
    </div>
  );
}
