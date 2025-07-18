"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Menu } from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export default function Topbar() {
  const { data: session } = useSession();

  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const links = [
    { href: "/pathfinder", label: "Path Finder" },
    { href: "/courses", label: "Courses" },
    { href: "/activities", label: "Activities" },
    { href: "/course-comparison", label: "Compare Courses" },
    { href: "/segments", label: "Segments" },
  ];

  return (
    <header className="sticky top-0 z-50 flex h-16 items-center justify-between gap-4 border-b bg-background px-4 sm:px-6 lg:px-8 w-full">
      <div className="flex items-center gap-4 w-full max-w-screen-xl mx-auto">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        >
          <Menu className="h-6 w-6" />
          <span className="sr-only">Toggle menu</span>
        </Button>

        <nav
          className={`${
            mobileMenuOpen ? "flex" : "hidden"
          } absolute left-0 right-0 top-16 flex-col gap-4 border-b bg-background px-6 py-6 md:static md:flex md:flex-row md:items-center md:gap-5 md:border-0 md:p-0 lg:gap-6`}
        >
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMobileMenuOpen(false)}
              className={`relative whitespace-nowrap transition-colors hover:text-foreground/80 ${
                pathname === link.href
                  ? "font-bold text-foreground after:absolute after:bottom-[-16px] after:left-0 after:h-[2px] after:w-full after:bg-primary"
                  : "text-foreground/60"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {session && (
          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="icon" className="rounded-full">
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={session?.user?.image} alt="Profile" />
                    <AvatarFallback>
                      {session?.user?.name
                        ?.split(" ")
                        .map((n) => n[0])
                        .join("") || "?"}
                    </AvatarFallback>
                  </Avatar>
                  <span className="sr-only">Toggle user menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>My Account</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">Settings</Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={async () => {
                    await signOut({ redirectTo: "/login" });
                  }}
                >
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </header>
  );
}
