import { useState } from "react";
import { ArrowUpToLine } from "@/components/ui/icon";

import { Button } from "@/components/ui/button";
import { BANNER } from "@/components/connection-banner";
import { checkForUpdate } from "@/lib/pwa";
import { useUpdateNotice } from "@/lib/self-update";

// The one place outside Settings an update speaks, and only while it cannot apply on its own: unsent
// work holds it, or the automatic retries are spent (ADR 0083). A row in the flow like the connection
// notice, never over the conversation, with nothing to dismiss: it goes when the update applies. The
// tap is Settings' "Reload interface": it waits for the new worker before navigating, and a draft is
// restored from its store after the reload.
export function UpdateBanner() {
  const shown = useUpdateNotice();
  const [run, setRun] = useState<"idle" | "busy" | "failed">("idle");
  if (!shown) return null;

  async function update() {
    setRun("busy");
    setRun((await checkForUpdate()) ? "idle" : "failed");
  }

  return (
    <div role="status" aria-live="polite" data-slot="update-banner" className={BANNER}>
      <ArrowUpToLine aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-footnote text-muted-foreground text-pretty">
        <span className="font-medium text-foreground">New version of Nenu.</span>
        {run === "failed" && " Couldn't finish updating."}
      </p>
      <Button size="sm" className="shrink-0" onClick={() => void update()} disabled={run === "busy"} aria-busy={run === "busy" || undefined}>
        {run === "busy" ? "Updating…" : run === "failed" ? "Try again" : "Update"}
      </Button>
    </div>
  );
}
