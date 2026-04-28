"use client";

import { AnimatePresence, motion } from "framer-motion";

import { Progress } from "@/components/ui/progress";
import { progressStore } from "@/store";

export function GlobalProgressBar() {
  const active = progressStore((s) => s.active);
  const label = progressStore((s) => s.label);
  const fraction = progressStore((s) => s.fraction);
  const tone = progressStore((s) => s.tone);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[10000]"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      aria-live="polite"
    >
      <AnimatePresence>
        {active && (
          <motion.div
            key="progress"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <Progress
              value={fraction !== null ? Math.round(fraction * 100) : 0}
              indeterminate={fraction === null}
              className="h-0.5 rounded-none bg-foreground/10"
              indicatorClassName={
                tone === "error" ? "bg-destructive" : "bg-primary"
              }
            />
            {label && (
              <motion.div
                key={label}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="px-3 pt-1 sm:px-4"
              >
                <span
                  className={
                    "inline-flex items-center gap-1.5 rounded-full bg-background/90 px-2 py-0.5 text-xs shadow-sm backdrop-blur-sm " +
                    (tone === "error"
                      ? "text-destructive"
                      : "text-muted-foreground")
                  }
                >
                  {tone === "error" ? null : (
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                    </span>
                  )}
                  {label}
                </span>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
