"use client";

import { GlobalProgressBar } from "@/components/global-progress-bar";
import { Toaster } from "@/components/ui/sonner";

export default function ReactProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalProgressBar />
      <Toaster />
      {children}
    </>
  );
}
