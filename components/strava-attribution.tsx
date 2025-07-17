/**
 * Strava API Brand Guidelines Compliance Components
 * 
 * Requirements from https://developers.strava.com/guidelines/:
 * - Must display "Powered by Strava" logo on pages with Strava data
 * - Must link back to original Strava data with "View on Strava"
 * - Logo must be separate from app branding
 */

import Link from "next/link";

interface StravaAttributionProps {
  className?: string;
}

export function StravaAttribution({ 
  className = "" 
}: StravaAttributionProps) {
  return (
    <div className={`flex items-center space-x-2 ${className}`}>
      <Link
        href="https://www.strava.com"
        target="_blank"
        rel="noopener noreferrer"
        className="block hover:opacity-80 transition-opacity"
      >
        <img
          src="/strava-logos/api_logo_pwrdBy_strava_horiz_black.svg"
          alt="Powered by Strava"
          className="h-6 w-auto"
        />
      </Link>
    </div>
  );
}

interface ViewOnStravaLinkProps {
  activityId?: number;
  routeId?: number;
  className?: string;
  children?: React.ReactNode;
}

export function ViewOnStravaLink({ 
  activityId,
  routeId,
  className = "",
  children 
}: ViewOnStravaLinkProps) {
  const href = activityId 
    ? `https://www.strava.com/activities/${activityId}`
    : `https://www.strava.com/routes/${routeId}`;
    
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-2 px-3 py-2 bg-[#FC5200] hover:bg-[#E54A00] text-white text-sm font-medium rounded-md transition-colors ${className}`}
    >
      {children || "View on Strava"}
    </Link>
  );
}
