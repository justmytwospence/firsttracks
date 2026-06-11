"use client";

import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { cn } from "@/lib/utils";

type ProgressProps = React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
  indeterminate?: boolean;
  indicatorClassName?: string;
};

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(({ className, value, indeterminate, indicatorClassName, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
      className,
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      data-indeterminate={indeterminate ? "" : undefined}
      className={cn(
        "h-full w-full flex-1 bg-primary transition-transform duration-200 ease-out",
        "data-[indeterminate]:w-1/3 data-[indeterminate]:animate-progress-indeterminate data-[indeterminate]:transition-none",
        indicatorClassName,
      )}
      style={
        indeterminate
          ? undefined
          : { transform: `translateX(-${100 - (value ?? 0)}%)` }
      }
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
