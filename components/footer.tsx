import { StravaAttribution } from "@/components/strava/strava-attribution";

export default function Footer() {
  return (
    <footer className="border-t border-border/40 mt-8">
      <div className="container mx-auto px-4 py-3">
        <div className="flex flex-col sm:flex-row justify-between items-center gap-2">
          <div className="text-xs text-muted-foreground">
            © 2025 Vertfarm. All rights reserved.
          </div>
          <StravaAttribution className="opacity-60 scale-75" />
        </div>
      </div>
    </footer>
  );
}
