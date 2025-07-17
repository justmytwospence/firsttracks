import Footer from "@/components/footer";
import Topbar from "@/components/topbar";
import type { Metadata } from "next";
import localFont from "next/font/local";
import ReactProviders from "./providers";
import "./globals.css";
import { auth } from "@/auth";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Strava Tools",
  description: "The things you wished Strava could do",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased relative`}
      >
        <ReactProviders session={session}>
          <div className="min-h-screen flex flex-col">
            <Topbar />
            <main className="flex-1 w-full max-w-screen-xl mx-auto px-4 sm:px-6 lg:px-8">{children}</main>
            <Footer />
          </div>
        </ReactProviders>
      </body>
    </html>
  );
}
