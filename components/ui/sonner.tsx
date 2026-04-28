"use client"

import { useEffect, useState } from "react"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 640px)")
    const update = () => setIsMobile(mql.matches)
    update()
    mql.addEventListener("change", update)
    return () => mql.removeEventListener("change", update)
  }, [])

  return (
    <Sonner
      theme="light"
      position={isMobile ? "bottom-center" : "bottom-right"}
      offset="calc(env(safe-area-inset-bottom, 0px) + 16px)"
      mobileOffset="calc(env(safe-area-inset-bottom, 0px) + 12px)"
      closeButton
      className="toaster group !z-[9999]"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border group-[.toaster]:border-border group-[.toaster]:shadow-md group-[.toaster]:rounded-md group-[.toaster]:text-sm group-[.toaster]:py-2 group-[.toaster]:pr-2 group-[.toaster]:pl-3 group-[.toaster]:max-w-sm data-[type=error]:!border-l-2 data-[type=error]:!border-l-destructive data-[type=warning]:!border-l-2 data-[type=warning]:!border-l-amber-500 data-[type=success]:!border-l-2 data-[type=success]:!border-l-emerald-500",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          closeButton:
            "group-[.toast]:bg-background group-[.toast]:text-muted-foreground group-[.toast]:border-border",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
