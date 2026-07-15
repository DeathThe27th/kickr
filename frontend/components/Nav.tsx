"use client";

import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { ChipIcon, Wordmark } from "./shared";

/** Live = the real TxLINE feed. Demo = simulated matches you start yourself.
 *  A filter, not a server switch — both run at once, so this never hides a
 *  real match from anyone else. */
function ModeToggle({ mode, onMode }: { mode: "live" | "demo"; onMode: (m: "live" | "demo") => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Data source"
      className="flex items-center gap-0.5 rounded-full border border-kickr-navy-line bg-kickr-navy-surface p-0.5"
    >
      {(["live", "demo"] as const).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          onClick={() => onMode(m)}
          className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kickr-yellow ${
            mode === m ? "bg-kickr-yellow text-kickr-navy" : "text-kickr-cream-dim hover:text-kickr-cream"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

export function AppNav({
  me,
  onFaucet,
  mode,
  onMode,
}: {
  me: any;
  onFaucet?: () => void;
  mode?: "live" | "demo";
  onMode?: (m: "live" | "demo") => void;
}) {
  const { logout, handle } = useAuth();
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <nav className="sticky top-0 z-40 border-b border-kickr-navy-line bg-kickr-navy/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        <Link href="/app" className="text-kickr-cream transition-opacity hover:opacity-80">
          <Wordmark className="text-2xl" />
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          {mode && onMode && <ModeToggle mode={mode} onMode={onMode} />}
          {me && (
            <span className="num flex items-center gap-1.5 rounded-full border border-kickr-navy-line bg-kickr-navy-surface px-3 py-1.5 text-sm font-semibold text-kickr-cream">
              <ChipIcon /> {me.balance?.toLocaleString()}
            </span>
          )}
          {me?.faucet_claimable && (
            <button
              onClick={onFaucet}
              className="rounded-full bg-kickr-yellow px-3 py-1.5 text-sm font-semibold text-kickr-navy transition-transform hover:-translate-y-0.5 active:translate-y-0"
            >
              +200 faucet
            </button>
          )}
          <div className="relative" ref={ref}>
            <button
              onClick={() => setMenu((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-kickr-yellow text-sm font-bold text-kickr-navy transition-transform hover:-translate-y-0.5"
              aria-label="menu"
            >
              {(handle ?? "?")[0]?.toUpperCase()}
            </button>
            {menu && (
              <div className="absolute right-0 mt-2 w-44 overflow-hidden rounded-xl border border-kickr-navy-line bg-kickr-navy-surface py-1 shadow-xl shadow-black/40">
                <Link
                  href="/positions"
                  className="block px-4 py-2.5 text-sm text-kickr-cream/90 hover:bg-kickr-navy-raised hover:text-kickr-cream"
                  onClick={() => setMenu(false)}
                >
                  Positions
                </Link>
                <Link
                  href="/leaderboard"
                  className="block px-4 py-2.5 text-sm text-kickr-cream/90 hover:bg-kickr-navy-raised hover:text-kickr-cream"
                  onClick={() => setMenu(false)}
                >
                  Leaderboard
                </Link>
                <button
                  className="block w-full border-t border-kickr-navy-line px-4 py-2.5 text-left text-sm text-kickr-cream-dim hover:bg-kickr-navy-raised hover:text-kickr-cream"
                  onClick={() => {
                    setMenu(false);
                    logout();
                    location.href = "/";
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
