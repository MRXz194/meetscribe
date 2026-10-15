import type { Metadata } from "next";
import Link from "next/link";
import { Be_Vietnam_Pro, Geist_Mono } from "next/font/google";
import { AudioLinesIcon } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { buttonVariants } from "@/components/ui/button";
import "./globals.css";

const sans = Be_Vietnam_Pro({
  variable: "--font-sans",
  subsets: ["vietnamese", "latin"],
  weight: ["400", "500", "600", "700"],
});

const mono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MeetScribe",
  description: "Transcript tiếng Việt realtime cho mọi cuộc họp trên máy tính",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className={`${sans.variable} ${mono.variable} h-full bg-background antialiased`}>
      <body className="min-h-full flex flex-col bg-muted/30">
        <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <AudioLinesIcon className="size-5 text-primary" />
              MeetScribe
            </Link>
            <nav className="ml-auto flex items-center gap-1">
              <Link href="/" className={buttonVariants({ variant: "ghost" })}>
                Cuộc họp
              </Link>
              <Link href="/record" className={buttonVariants()}>
                Ghi cuộc họp mới
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
