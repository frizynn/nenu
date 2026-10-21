import { useId, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { ChevronRight, Clock, FileText, GitPullRequest, Pencil, X } from "@/components/ui/icon";

import { errorMessage } from "@/components/node-start";
import { Button } from "@/components/ui/button";
import { inputField, textField } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import type { Routines } from "@/hooks/use-routines";
import { timeAgo, timeUntilShort } from "@/lib/format";
import { openCoordinators, orgTree } from "@/lib/org-tree";
import { ROUTINE_EVENTS, routineChanges, routineDraft, routineRecipient, routineRecipientShort, routineWhen, type RoutineDraft } from "@/lib/project-work";
import type { ProjectThreadView, RoutineEdit, RoutineView } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A page's routines (ADR 0102): each one's trigger, when it runs, whom it reaches and the first words of
 * what it asks, a switch that turns it on or off through Organizations' `routine toggle`, and its detail
 * beside the list. Where Organizations has `routine set` (ADR 0106), Edit changes its trigger, whom it
 * reaches and its prompt. A routine is created and its command approved at a terminal, where approving
 * a command is the person's own step.
 */
export function RoutinesPanel({ routines, shown, threads, readOnly, empty, narrow = false }: {
  routines: Routines;
  /** The routines this page lists, out of the project's. */
  shown: (list: readonly RoutineView[]) => RoutineView[];
  threads: readonly ProjectThreadView[];
  readOnly: boolean;
  empty: string;
  /** A column, not a page (a chat's panel or tab): the detail opens under the list, and the list is not explained. */
  narrow?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const [failed, setFailed] = useState<string>();
  // One change at a time: each answer is the whole list, so two in flight would let the older one win.
  const [busy, setBusy] = useState(false);
  const { list, error } = routines;
  const listed = list ? shown(list.routines) : [];
  // The first routine opens beside the list until another is picked; closing it leaves `routine=` empty.
  const asked = params.get("routine");
  // A column opens none until one is picked.
  const open = asked === null ? (narrow ? undefined : listed[0]) : listed.find((routine) => routine.name === asked);
  const select = (name?: string) => setParams((current) => {
    const kept = new URLSearchParams(current);
    kept.set("routine", name ?? "");
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
  const editable = !readOnly && list?.editable === true;

  return <div className={cn("grid items-start", narrow ? "gap-3" : "gap-5", open && !narrow && "lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]")}>
    <div className="min-w-0">
      {!narrow && <p className="mb-3 px-1 text-footnote text-muted-foreground">What runs on its own: on a schedule, or when a pull request changes. Each one sends its prompt to whom it names.</p>}
      {failed && <p role="alert" className="mb-3 px-1 text-footnote text-destructive">{failed}</p>}
      {!list && !error ? line("Reading…")
        : error ? line(error)
        : !list?.available ? line("This Herdr Organizations can’t list routines yet; update it to see them here.")
        : listed.length === 0 ? line(empty)
        : <ul className="flex flex-col gap-2">{listed.map((routine) => {
          const Icon = routine.trigger === "pr" ? GitPullRequest : Clock;
          const chosen = routine.name === open?.name;
          return <li key={routine.name} className="desk-card routine-row" data-chosen={chosen ? "" : undefined}>
            <span className="desk-card-mark"><Icon aria-hidden size={16} /></span>
            <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={chosen} onClick={() => select(chosen ? undefined : routine.name)}>
              <span className="flex items-center gap-2 text-subhead font-medium">
                <span className="truncate">{routine.name}</span>
                {!routine.enabled && <span className="routine-off">Off</span>}
              </span>
              <span className="block text-footnote text-muted-foreground line-clamp-2">{routineWhen(routine)} · {routineRecipientShort(routine, threads)}</span>
              {routine.prompt && <span className="mt-0.5 block truncate text-footnote text-subtle-foreground">{routine.prompt.split("\n")[0]}</span>}
            </button>
            <Switch checked={routine.enabled} disabled={readOnly || busy} aria-label={`${routine.name} on`}
              onCheckedChange={(on) => void toggle(routine, on)} />
            {!chosen && <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle-foreground" />}
          </li>;
        })}</ul>}
      {list?.broken ? <p className="mt-3 px-1 text-footnote text-muted-foreground">{list.broken} routine {list.broken === 1 ? "file does" : "files do"} not parse.</p> : null}
    </div>
    {open && <RoutineDetail key={open.name} routine={open} threads={threads} editable={editable} onSave={(edit) => routines.save(open.name, edit)} onClose={() => select()} />}
  </div>;
}

function RoutineDetail({ routine, threads, editable, onSave, onClose }: {
  routine: RoutineView;
  threads: readonly ProjectThreadView[];
  editable: boolean;
  onSave: (edit: RoutineEdit) => Promise<void>;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const now = Date.now();
  const last = Date.parse(routine.lastRun);
  const next = Date.parse(routine.nextRun);
  const rows: Array<[string, string]> = [
    ["Runs when", routine.trigger === "pr" ? routineWhen(routine) : `${routine.schedule}${Number.isNaN(next) ? "" : `, next ${timeUntilShort(next)}`}`],
    ["Goes to", routineRecipient(routine, threads)],
    ["Last run", routine.trigger === "pr" ? "Not recorded for pull-request routines" : Number.isNaN(last) ? "Not yet" : timeAgo(last, now)],
  ];
  return <aside aria-label={`Routine ${routine.name}`} className="desk-card routine-detail min-w-0 p-4">
    <div className="mb-3 flex min-h-8 items-center gap-2">
      <h2 className="min-w-0 flex-1 truncate text-headline">{routine.name}</h2>
      <span className={cn("routine-state", routine.enabled && "routine-state-on")}>{routine.enabled ? "On" : "Off"}</span>
      {editable && !editing && <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil aria-hidden className="size-3.5" />Edit</Button>}
      <button type="button" className="desk-icon-button" aria-label="Close routine" onClick={onClose}><X aria-hidden size={16} /></button>
    </div>
    {editing
      ? <RoutineForm routine={routine} threads={threads} onSave={onSave} onDone={() => setEditing(false)} />
      : <>
        <dl className="overflow-hidden rounded-lg border border-border text-footnote">
          {rows.map(([term, value]) => <div key={term} className="flex gap-3 px-3 py-2 [&+&]:border-t [&+&]:border-border">
            <dt className="w-20 shrink-0 text-muted-foreground">{term}</dt><dd className="min-w-0 flex-1 text-right break-words">{value}</dd>
          </div>)}
        </dl>
        <h3 className="mt-4 mb-1.5 text-footnote text-muted-foreground">What it asks</h3>
        <p className="rounded-lg bg-muted px-3 py-2.5 text-subhead whitespace-pre-wrap break-words">{routine.prompt || "Nothing: it only runs its command."}</p>
      </>}
    <p className="mt-3 flex items-center gap-1.5 font-mono text-caption text-muted-foreground"><FileText aria-hidden className="size-3.5" />routines/{routine.name}.md</p>
  </aside>;
}

/** Whom a routine can reach: the project coordinator, the pull request's thread, an open coordinator, the node it names now, or a new thread. */
function destinations(routine: RoutineDraft, open: ReadonlyArray<{ value: string; label: string }>, threads: readonly ProjectThreadView[], current: string): Array<{ value: string; label: string }> {
  const coordinators = open.map((option) => ({ value: `node:${option.value}`, label: option.label }));
  const named = current.startsWith("node:") && !coordinators.some((option) => option.value === current)
    ? [{ value: current, label: threads.find((thread) => `node:${thread.id}` === current)?.title ?? current.slice("node:".length) }] : [];
  return [
    { value: "root", label: "The project coordinator" },
    ...(routine.trigger === "pr" ? [{ value: "owner", label: "The thread that owns the pull request" }] : []),
    ...coordinators, ...named,
    { value: "new", label: "A new thread" },
  ];
}

function RoutineForm({ routine, threads, onSave, onDone }: {
  routine: RoutineView;
  threads: readonly ProjectThreadView[];
  onSave: (edit: RoutineEdit) => Promise<void>;
  onDone: () => void;
}) {
  const id = useId();
  const initial = useMemo(() => routineDraft(routine, threads), [routine, threads]);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (patch: Partial<RoutineDraft>) => setDraft((current) => {
    const next = { ...current, ...patch };
    // Only a pull request routine reaches the pull request's thread.
    if (next.trigger === "schedule" && next.to === "owner") next.to = "root";
    return next;
  });
  const edit = routineChanges(routine, threads, draft);
  const changed = Object.keys(edit).length > 0;
  const coordinators = useMemo(() => openCoordinators(orgTree(threads)).map(({ node }) => ({ value: node.thread.id, label: node.thread.title })), [threads]);
  // The node a new thread starts under now, even when it is no open coordinator, so the editor says what the file says.
  const parents = [{ value: "root", label: "the project" }, ...coordinators,
    ...(initial.parent !== "root" && !coordinators.some((option) => option.value === initial.parent)
      ? [{ value: initial.parent, label: threads.find((thread) => thread.id === initial.parent)?.title ?? initial.parent }] : [])];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(edit);
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return <form aria-label={`Edit ${routine.name}`} className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
    <div className="flex flex-col gap-1.5">
      <span className="routine-label">Runs</span>
      <Segmented label="Runs" className="w-full" value={draft.trigger} onChange={(trigger) => set({ trigger })}
        options={[{ value: "schedule", label: "On a schedule" }, { value: "pr", label: "On pull requests" }]} />
      {draft.trigger === "schedule"
        ? <>
          <label htmlFor={`${id}-schedule`} className="sr-only">Schedule</label>
          <input id={`${id}-schedule`} className={inputField} value={draft.schedule} placeholder="daily 09:00" spellCheck={false} autoComplete="off"
            onChange={(event) => set({ schedule: event.target.value })} />
          <span className="text-caption text-muted-foreground">every 30m · every 2h · every 1d · daily 09:00</span>
        </>
        : <fieldset className="flex flex-wrap gap-1.5">
          <legend className="sr-only">Pull request events</legend>
          {ROUTINE_EVENTS.map((event) => {
            const on = draft.events.includes(event.id);
            return <button key={event.id} type="button" role="checkbox" aria-checked={on} className="routine-event"
              onClick={() => set({ events: on ? draft.events.filter((id) => id !== event.id) : [...draft.events, event.id] })}>{event.label}</button>;
          })}
        </fieldset>}
    </div>
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-to`} className="routine-label">Goes to</label>
      <SelectField id={`${id}-to`} value={draft.to} onChange={(event) => set({ to: event.target.value })}>
        {destinations(draft, coordinators, threads, initial.to).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </SelectField>
      {draft.to === "new" && <>
        <label htmlFor={`${id}-parent`} className="sr-only">Under</label>
        <SelectField id={`${id}-parent`} value={draft.parent} onChange={(event) => set({ parent: event.target.value })}>
          {parents.map((option) => <option key={option.value} value={option.value}>Under {option.label}</option>)}
        </SelectField>
      </>}
    </div>
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-prompt`} className="routine-label">What it asks</label>
      <textarea id={`${id}-prompt`} className={textField} rows={6} value={draft.prompt} maxLength={8_000} onChange={(event) => set({ prompt: event.target.value })} />
    </div>
    {error && <p role="alert" className="text-footnote text-destructive">{error}</p>}
    <div className="flex justify-end gap-2">
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
      <Button type="submit" size="sm" disabled={!changed || busy || (draft.trigger === "pr" && draft.events.length === 0) || edit.prompt === ""} aria-busy={busy || undefined}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </div>
  </form>;
}
