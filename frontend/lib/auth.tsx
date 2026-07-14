"use client";

/** Auth: Privy when NEXT_PUBLIC_PRIVY_APP_ID is set; otherwise a dev sign-in
 * (token `dev:<handle>`) so the product runs with zero external credentials
 * (build.md §9 spirit). The consuming code sees one hook either way. */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

type Auth = {
  ready: boolean;
  authed: boolean;
  handle: string | null;
  getToken: () => Promise<string | null>;
  login: () => void;
  logout: () => void;
};

const AuthCtx = createContext<Auth>({
  ready: false,
  authed: false,
  handle: null,
  getToken: async () => null,
  login: () => {},
  logout: () => {},
});

export const useAuth = () => useContext(AuthCtx);

function DevAuthProvider({ children }: { children: React.ReactNode }) {
  const [handle, setHandle] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [prompting, setPrompting] = useState(false);

  useEffect(() => {
    setHandle(localStorage.getItem("kickr-dev-handle"));
    setReady(true);
  }, []);

  const login = useCallback(() => setPrompting(true), []);
  const logout = useCallback(() => {
    localStorage.removeItem("kickr-dev-handle");
    setHandle(null);
  }, []);
  const getToken = useCallback(async () => (handle ? `dev:${handle}` : null), [handle]);

  const value = useMemo(
    () => ({ ready, authed: !!handle, handle, getToken, login, logout }),
    [ready, handle, getToken, login, logout]
  );

  return (
    <AuthCtx.Provider value={value}>
      {children}
      {prompting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kickr-ink/40 p-4">
          <form
            className="w-full max-w-sm rounded-2xl border border-kickr-line bg-white p-6 shadow-xl"
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get("handle")?.toString().trim();
              if (v) {
                localStorage.setItem("kickr-dev-handle", v);
                setHandle(v);
                setPrompting(false);
              }
            }}
          >
            <h2 className="font-display text-xl">sign in</h2>
            <p className="mt-1 text-sm text-kickr-ink/60">
              Demo mode — pick a handle. (Set NEXT_PUBLIC_PRIVY_APP_ID for real Privy auth.)
            </p>
            <input
              name="handle"
              autoFocus
              placeholder="your-handle"
              className="mt-4 w-full rounded-lg border border-kickr-line px-3 py-2 outline-none focus:border-kickr-yellow-deep"
            />
            <div className="mt-4 flex gap-2">
              <button
                type="submit"
                className="flex-1 rounded-lg bg-kickr-yellow px-4 py-2 font-semibold hover:bg-kickr-yellow-deep"
              >
                Start with 1,000 chips
              </button>
              <button
                type="button"
                onClick={() => setPrompting(false)}
                className="rounded-lg border border-kickr-line px-4 py-2"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </AuthCtx.Provider>
  );
}

function PrivyAuthBridge({ children }: { children: React.ReactNode }) {
  // Imported lazily so the dev path never needs the Privy SDK at runtime.
  const { usePrivy } = require("@privy-io/react-auth");
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const value = useMemo<Auth>(
    () => ({
      ready,
      authed: authenticated,
      handle: user?.id ? user.id.split(":").pop()!.slice(0, 12) : null,
      getToken: () => getAccessToken(),
      login,
      logout,
    }),
    [ready, authenticated, user, login, logout, getAccessToken]
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  if (!PRIVY_APP_ID) return <DevAuthProvider>{children}</DevAuthProvider>;
  const { PrivyProvider } = require("@privy-io/react-auth");
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{ appearance: { accentColor: "#FFDE00" }, embeddedWallets: { createOnLogin: "off" } }}
    >
      <PrivyAuthBridge>{children}</PrivyAuthBridge>
    </PrivyProvider>
  );
}
