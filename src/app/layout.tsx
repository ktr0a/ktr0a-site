import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { getContentConfig } from "@/lib/config";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export async function generateMetadata(): Promise<Metadata> {
  const config = getContentConfig();
  return {
    title: config.general.site_title,
    description: config.general.site_description,
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans bg-navy-950 text-slate-200 antialiased`}>
        {children}
      </body>
    </html>
  );
}
