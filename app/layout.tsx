import type { Metadata } from "next";
import { Archivo, Instrument_Serif } from "next/font/google";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Superteam NL (STNL) | Solana Netherlands",
    template: "%s - Superteam NL",
  },
  description:
    "Superteam NL (STNL) is the Solana community in the Netherlands. Meet builders, join events, and find grants and bounties in the Dutch Solana ecosystem.",
  openGraph: {
    type: "website",
    siteName: "Superteam NL",
  },
  twitter: {
    // the brand mark is square, so use the square card
    card: "summary",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-cream text-ink font-sans">
        {children}
      </body>
    </html>
  );
}
