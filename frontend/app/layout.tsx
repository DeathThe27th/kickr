import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono, Pacifico } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";

// Display: Space Grotesk 700 — modern, technical, pairs with the mono figures.
// (Swap candidates if you want a different feel: Anton = poster/matchday punch,
//  Bricolage Grotesque = editorial character.)
const display = Space_Grotesk({ weight: "700", subsets: ["latin"], variable: "--font-display" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
// Wordmark script — a stand-in for the hand-lettered "kickr." logo mark.
// Swap for the real SVG when exported.
const script = Pacifico({ weight: "400", subsets: ["latin"], variable: "--font-script" });

export const metadata: Metadata = {
  title: "kickr — markets that live inside the match",
  description:
    "Micro prediction markets on every World Cup fixture — priced live, settled in seconds, receipts on-chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${inter.variable} ${jetbrains.variable} ${script.variable}`}>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
