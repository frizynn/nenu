import { useEffect, useState } from "react";
import { Link } from "react-router";

import { ChevronRight, Pending } from "@/components/ui/icon";
import { listRowClass, listRowPressable, ListRow, ListSection } from "@/components/ui/list-group";
import { Switch, switchSlot } from "@/components/ui/switch";
import { getUsage, setUsage } from "@/lib/api";
import { concerns, onLiveEvent } from "@/lib/live-events";
import { usagePath } from "@/lib/nav";
import type { UsageResponse } from "@/lib/types";
import { accountsLine, usageLine } from "@/lib/usage";

// Settings → Usage (bridge/usage/, ADR 0085). Bridge-wide and off by default: nothing reads a log
// until the operator turns it on here. Read when Settings opens and again when the bridge says usage
// changed (a scan moved on or ended), never on a timer. A switch moves at once and settles on the
// bridge's answer, or back where it was if the change fails.
export function UsageControl({ readOnly = false, session }: { readOnly?: boolean; session?: string }) {
  const [usage, setState] = useState<UsageResponse | null>(null);
  // The switch being changed shows its new position at once; everything else waits for the bridge.
  const [pending, setPending] = useState<{ on?: boolean; splitByAccount?: boolean } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = () => getUsage().then((u) => alive && setState(u), () => alive && setFailed(true));
    read();
    const stop = onLiveEvent((event) => { if (concerns(event, "usage")) read(); });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  async function change(patch: { on?: boolean; splitByAccount?: boolean }) {
    setPending(patch);
    try {
      setState(await setUsage(patch));
    } catch {
      // The switch goes back to what the bridge last said.
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;
  const on = usage?.on === true;
  // Said only while there is nothing to show: a later read that works takes its place.
  const footer = failed && !usage
    ? <span className="text-destructive">Couldn&rsquo;t read the usage settings.</span>
    : on
      ? "Cost is the API list price of these tokens, not what your plans charge."
      : "Off by default. The first pass reads every log once; after that Nenu reads only new lines.";

  return (
    <ListSection title="Usage" footer={footer}>
      <ListRow title="Track usage" hint={on ? undefined : "Totals tokens and API-equivalent cost from the Claude Code and Codex logs on this machine. Nothing leaves it."}>
        <div className={switchSlot}>
          {usage ? (
            <Switch checked={pending?.on ?? on} disabled={busy || readOnly} onCheckedChange={(next) => void change({ on: next })} aria-label="Track usage" />
          ) : (
            !failed && <Pending aria-hidden="true" className="size-4 text-muted-foreground" />
          )}
        </div>
      </ListRow>
      <ListRow title="Split by account" hint={usage?.on && usage.splitByAccount ? accountsLine(usage.accounts) : undefined}>
        <Switch checked={pending?.splitByAccount ?? Boolean(usage?.splitByAccount)} disabled={!on || busy || readOnly} onCheckedChange={(next) => void change({ splitByAccount: next })} aria-label="Split by account" />
      </ListRow>
      {usage?.on && (
        <Link to={usagePath(session)} className={`${listRowClass} ${listRowPressable}`}>
          <span className="flex-1 text-body">Usage</span>
          <span className="truncate text-footnote text-muted-foreground tabular-nums">{usageLine(usage)}</span>
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-subtle-foreground" />
        </Link>
      )}
    </ListSection>
  );
}
