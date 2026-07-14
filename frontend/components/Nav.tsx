"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ChipIcon, Wordmark } from "./shared";

export function AppNav({ me, onFaucet }: { me: any; onFaucet?: () => void }) {
  const { logout, handle } = useAuth();
  const [menu, setMenu] = useState(false);
  return (
    <nav className="sticky top-0 z-40 border-b border-kickr-line bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/app">
          <Wordmark className="text-2xl" />
        </Link>
        <div className="flex items-center gap-3">
          {me && (
            <span className="num flex items-center gap-1.5 rounded-full border border-kickr-line px-3 py-1 text-sm font-semibold">
              <ChipIcon /> {me.balance?.toLocaleString()}
            </span>
          )}
          {me?.faucet_claimable && (
            <button
              onClick={onFaucet}
              className="rounded-full bg-kickr-yellow px-3 py-1 text-sm font-semibold hover:bg-kickr-yellow-deep"
            >
              +200 faucet
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setMenu((v) => !v)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-kickr-ink text-sm font-bold text-kickr-yellow"
              aria-label="menu"
            >
              {(handle ?? "?")[0]?.toUpperCase()}
            </button>
            {menu && (
              <div className="absolute right-0 mt-2 w-44 rounded-xl border border-kickr-line bg-white py-1 shadow-lg">
                <Link href="/positions" className="block px-4 py-2 text-sm hover:bg-kickr-yellow/20" onClick={() => setMenu(false)}>
                  Positions
                </Link>
                <Link href="/leaderboard" className="block px-4 py-2 text-sm hover:bg-kickr-yellow/20" onClick={() => setMenu(false)}>
                  Leaderboard
                </Link>
                <button
                  className="block w-full px-4 py-2 text-left text-sm hover:bg-kickr-yellow/20"
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
