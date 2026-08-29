import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import "./connections.css";

const manrope = Manrope({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Cloud SalvaWeb",
  icons: { icon: "/cloud-mark.svg", apple: "/cloud-mark.svg" },
  description: "Private storage control plane"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={manrope.className}>{children}</body></html>;
}
