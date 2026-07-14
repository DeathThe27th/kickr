import type { Config } from "tailwindcss";

/** Kickr design tokens — build.md §8.1, locked palette. */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        kickr: {
          yellow: "#FFDE00",
          "yellow-deep": "#EAB700",
          ink: "#101314",
          line: "#E7E5DC",
          live: "#E5484D",
          win: "#28C76F",
          loss: "#F0616D",
          // Navy/cream brand system (logo-led). Yellow stays the LIVE accent.
          navy: "#141B26", // page base
          "navy-surface": "#1C2634", // cards / elevated
          "navy-raised": "#243040", // hover / higher elevation
          "navy-line": "#2E3C4E", // hairlines on navy
          cream: "#ECE6D5", // primary ink on navy (logo cream)
          "cream-dim": "#A9AEB4", // secondary text (passes AA on navy)
        },
      },
      fontFamily: {
        display: ["var(--font-archivo)", "sans-serif"],
        body: ["var(--font-inter)", "sans-serif"],
        mono: ["var(--font-jetbrains)", "monospace"],
        script: ["var(--font-script)", "cursive"],
      },
      boxShadow: {
        "live-glow": "0 0 0 1px rgba(255,222,0,0.5), 0 8px 40px -8px rgba(255,222,0,0.35)",
      },
    },
  },
  plugins: [],
};
export default config;
