import { useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronRight, Clock, FileText, GitPullRequest, X } from "@/components/ui/icon";

import { errorMessage } from "@/components/node-start";
import { Switch } from "@/components/ui/switch";
import type { Routines } from "@/hooks/use-routines";
import { timeAgo, timeUntilShort } from "@/lib/format";
import { routineRecipient, routineRecipientShort, routineWhen } from "@/lib/project-work";
import type { ProjectThreadView, RoutineView } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A page's routines (ADR 0102): each one's trigger, when it runs and whom it reaches, a switch that turns
 * it on or off through Organizations' `routine toggle`, and its detail beside the list: when, whom, the
 * last run and what it asks, as its file says. A routine is created and its command approved at a
 * terminal, where approving a command is the person's own step.
 */
export function RoutinesPanel({ routines, shown, threads, readOnly, empty }: {
  routines: Routines;
  /** The routines this page lists, out of the project's. */
  shown: (list: readonly RoutineView[]) => RoutineView[];
  threads: readonly ProjectThreadView[];
  readOnly: boolean;
  empty: string;
}) {
  const [params, setParams] = useSearchParams();
  const [failed, setFailed] = useState<string>();
  // One change at a time: each answer is the whole list, so two in flight would let the older one win.
  const [busy, setBusy] = useState(false);
  const { list, error } = routines;
  const listed = list ? shown(list.routines) : [];
  const open = listed.find((routine) => routine.name === params.get("routine"));
  const select = (name?: string) => setParams((current) => {
    const kept = new URLSearchParams(current);
    if (name) kept.set("routine", name);
    else kept.delete("routine");
    return kept;
  }, { replace: true });
  const toggle = async (routine: RoutineView, on: boolean) => {
    setBusy(true);
    setFailed(undefined);
    try {
      await routines.toggle(routine.name, on);
    } catch (failure) {
      setFailed(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const line = (text: string) => <p className="px-1 text-subhead text-muted-foreground">{text}</p>;

  return <div className={cn("grid items-start gap-5", open && "grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
    <div className="min-w-0">
      <p className="mb-3 px-1 text-footnote text-muted-foreground">What runs on its own: on a schedule, or when a pull request changes.</p>
      {failed && <p role="alert" className="mb-3 px-1 text-footnote text-destructive">{failed}</p>}
      {!list && !error ? line("Reading…")
        : error ? line(error)
        : !list?.available ? line("This Herdr Organizations can’t list routines yet; update it to see them here.")
        : listed.length === 0 ? line(empty)
        : <ul className="flex flex-col gap-2">{listed.map((routine) => {
          const Icon = routine.trigger === "pr" ? GitPullRequest : Clock;
          return <li key={routine.name} className={cn("desk-card flex items-center gap-3 px-3 py-2.5", routine.name === open?.name && "bg-accent")}>
            <span className="desk-card-mark"><Icon aria-hidden size={15} /></span>
            <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={routine.name === open?.name} onClick={() => select(routine.name === open?.name ? undefined : routine.name)}>
              <span className="block truncate text-subhead font-medium">{routine.name}</span>
              <span className="block truncate text-footnote text-muted-foreground">{routineWhen(routine)} · {routineRecipientShort(routine, threads)}</span>
            </button>
            <Switch checked={routine.enabled} disabled={readOnly || busy} aria-label={`${routine.name} on`}
              onCheckedChange={(on) => void toggle(routine, on)} />
            <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle-foreground" />
          </li>;
        })}</ul>}
      {list?.broken ? <p className="mt-3 px-1 text-footnote text-muted-foreground">{list.broken} routine {list.broken === 1 ? "file does" : "files do"} not parse.</p> : null}
    </div>
    {open && <RoutineDetail routine={open} threads={threads} onClose={() => select()} />}
  </div>;
}

function RoutineDetail({ routine, threads, onClose }: { routine: RoutineView; threads: readonly ProjectThreadView[]; onClose: () => void }) {
  const now = Date.now();
  const last = Date.parse(routine.lastRun);
  const next = Date.parse(routine.nextRun);
  const rows: Array<[string, string]> = [
    ["Runs when", routine.trigger === "pr" ? routineWhen(routine) : `${routine.schedule}${Number.isNaN(next) ? "" : `, next in ${timeUntilShort(next)}`}`],
    ["Goes to", routineRecipient(routine, threads)],
    ["Last run", routine.trigger === "pr" ? "Not recorded for pull-request routines" : Number.isNaN(last) ? "Not yet" : timeAgo(last, now)],
  ];
  return <aside aria-label={`Routine ${routine.name}`} className="desk-card min-w-0 p-4">
    <div className="mb-3 flex items-center gap-2">
      <h2 className="min-w-0 flex-1 truncate text-headline">{routine.name}</h2>
      <span className="text-footnote text-muted-foreground">{routine.enabled ? "On" : "Off"}</span>
      <button type="button" className="desk-icon-button" aria-label="Close routine" onClick={onClose}><X aria-hidden size={15} /></button>
    </div>
    <dl className="overflow-hidden rounded-lg border border-border text-footnote">
      {rows.map(([term, value]) => <div key={term} className="flex gap-3 px-3 py-2 [&+&]:border-t [&+&]:border-border">
        <dt className="w-20 shrink-0 text-muted-foreground">{term}</dt><dd className="min-w-0 flex-1 text-right break-words">{value}</dd>
      </div>)}
    </dl>
    <h3 className="mt-4 mb-1.5 text-footnote text-muted-foreground">What it asks</h3>
    <p className="rounded-lg border border-border px-3 py-2.5 text-subhead whitespace-pre-wrap break-words">{routine.prompt || "Nothing: it only runs its command."}</p>
    <p className="mt-3 flex items-center gap-1.5 font-mono text-caption text-muted-foreground"><FileText aria-hidden className="size-3.5" />routines/{routine.name}.md</p>
  </aside>;
}
