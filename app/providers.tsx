"use client";

import { Toaster } from "@/components/ui/sonner";

export default function ReactProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Toaster richColors expand={true} />
      {children}
    </>
  );
}
