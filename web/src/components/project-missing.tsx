import { useState } from "react";
import { Link, useRevalidator } from "react-router";
import { FolderX, Loader2 } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { homePath } from "@/lib/nav";
import { cn } from "@/lib/utils";

/** How long Check again shows its work at least: a read that answers within a frame looked like a dead button. */
const CHECK_SHOWN_MS = 400;

/** A link to a project this Herdr session does not have (an old link, or another session's): Home, or read again. */
export function ProjectMissing({ session }: { session?: string }) {
  const revalidator = useRevalidator();
  // Its own flag, not the revalidator's state: the background poll would light the button too.
  const [checking, setChecking] = useState(false);
  async function check() {
    setChecking(true);
    try {
      await Promise.all([revalidator.revalidate(), new Promise((resolve) => setTimeout(resolve, CHECK_SHOWN_MS))]);
    } finally {
      setChecking(false);
    }
  }
  return (
    <EmptyState icon={FolderX} title="Project not found" action={<div className="flex flex-wrap justify-center gap-3">
      <Link to={homePath(session)} className={cn(buttonVariants({ size: "lg" }))}>Go to Home</Link>
      <Button type="button" variant="outline" size="lg" disabled={checking} aria-busy={checking || undefined} onClick={() => void check()}>
        {checking && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}{checking ? "Checking…" : "Check again"}
      </Button>
    </div>}>
      This Herdr session has no project at this link.
    </EmptyState>
  );
}
