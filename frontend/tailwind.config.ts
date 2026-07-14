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
          win: "#1F9D55",
          loss: "#E5484D",
        },
      },
      fontFamily: {
        display: ["var(--font-archivo)", "sans-serif"],
        body: ["var(--font-inter)", "sans-serif"],
        mono: ["var(--font-jetbrains)", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
