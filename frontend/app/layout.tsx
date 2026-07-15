import type { Metadata } from "next";
import { Space_Grotesk, Inter, Azeret_Mono, Pacifico } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";

// Display: Space Grotesk 700 — modern, technical, pairs with the mono figures.
// (Swap candidates if you want a different feel: Anton = poster/matchday punch,
//  Bricolage Grotesque = editorial character.)
const display = Space_Grotesk({ weight: "700", subsets: ["latin"], variable: "--font-display" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
// Figures: Azeret Mono — squared terminals and tall tabular figures, so odds,
// clocks and scores read like an instrument rather than body copy.
const mono = Azeret_Mono({ subsets: ["latin"], variable: "--font-mono" });
// Wordmark script — a stand-in for the hand-lettered "kickr." logo mark.
// Swap for the real SVG when exported.
const script = Pacifico({ weight: "400", subsets: ["latin"], variable: "--font-script" });

export const metadata: Metadata = {
  title: "kickr — markets that live and die inside the match",
  description:
    "Live micro markets for every World Cup fixture that settle in seconds with onchain receipts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${inter.variable} ${mono.variable} ${script.variable}`}>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
