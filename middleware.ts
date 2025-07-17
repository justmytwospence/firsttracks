import authConfig from "@/auth.config";
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const { auth } = NextAuth(authConfig);

export async function middleware(request: NextRequest) {
  const session = await auth();

  if (request.nextUrl.pathname === '/') {
    return NextResponse.redirect(new URL('/pathfinder', request.url));
  }

  if (!session) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirectUrl", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: 
    /*
     * Match all paths except:
     * 1. /api/* (API endpoints)
     * 2. /login (login page)
     * 3. /_next (Next.js internals)
     * 4. /static (static files)
     * 5. /favicon.ico, etc. (static files)
     * 6. /strava-logos/* (Strava brand assets)
     */
    "/((?!api/|login|logout|pathfinder|_next|static|favicon.ico|strava-logos/).*)",
};
