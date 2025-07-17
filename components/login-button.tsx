import { auth, signIn, signOut } from "@/auth";
import { Button } from "@/components/ui/button";
import { baseLogger } from "@/lib/logger";
import Image from "next/image";

export function SignIn({ redirectUrl }: { redirectUrl?: string }) {
  return (
    <form
      action={async () => {
        "use server";
        await signIn("strava", { redirectTo: redirectUrl });
      }}
    >
      <button
        type="submit"
        className="block hover:opacity-80 transition-opacity border-0 p-0 bg-transparent"
        aria-label="Connect with Strava"
      >
        {/* Using the official Strava Connect button as per brand guidelines */}
        <img
          src="/strava-logos/btn_strava_connect_with_orange_x2.svg"
          alt="Connect with Strava"
          className="h-12 w-auto"
        />
      </button>
    </form>
  );
}

export function SignOut({ session }: { session: unknown }) {
  return (
    <form
      action={async () => {
        "use server";
        await signOut();
      }}
    >
      <Button className="w-full font-bold" type="submit">
        Sign Out
      </Button>
    </form>
  );
}

export default async function LoginButton({ 
  redirectUrl 
}: { 
  redirectUrl?: string 
}) {
  const session = await auth();
  baseLogger.info(`Session: ${JSON.stringify(session, null, 2)}`);
  if (session) {
    return <SignOut session={session} />;
  }
  return <SignIn redirectUrl={redirectUrl} />;
}
