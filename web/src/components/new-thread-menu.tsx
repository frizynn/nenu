import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { fetchOrgTemplates, startOrgNode } from "@/lib/api";
import type { ProjectView, TemplateView } from "@/lib/types";

export type TemplateLoad =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; templates: TemplateView[] };

type StartForm = { title: string; parent: string; task: string };

const FIELD = "mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-sm font-normal";

/** Templates for a project, read when `active` turns on, so a closed menu never pays for them. */
export function useTemplates(project: string, session: string | undefined, active: boolean): TemplateLoad {
  const [load, setLoad] = useState<TemplateLoad>({ kind: "loading" });
  useEffect(() => {
    if (!active || !project) return;
    let current = true;
    setLoad({ kind: "loading" });
    fetchOrgTemplates(project, session).then(
      (response) => { if (current) setLoad({ kind: "ready", templates: response.templates }); },
      (failure: unknown) => { if (current) setLoad({ kind: "error", message: errorMessage(failure) }); },
    );
    return () => { current = false; };
  }, [active, project, session]);
  return load;
}

/** A quiet "New thread" trigger: pick a project template, then name the thread and its task. */
export function NewThreadMenu({ project, session, onStarted }: {
  project: ProjectView;
  session?: string;
  onStarted: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const load = useTemplates(project.slug, session, menuOpen);
  const [template, setTemplate] = useState<TemplateView | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function choose(next: TemplateView) {
    setMenuOpen(false);
    setTemplate(next);
  }

  return <>
    <button ref={trigger} type="button" className="quiet-action" aria-expanded={menuOpen} aria-haspopup="dialog" onClick={() => setMenuOpen((open) => !open)}>
      <Plus aria-hidden className="size-4" />New thread
    </button>
    <WorkbenchPopover open={menuOpen} onDismiss={() => setMenuOpen(false)} anchorRef={trigger} label="Start from a template" className="[&>div:last-child]:p-1.5">
      {load.kind === "loading" && <p className="p-2.5 text-sm text-muted-foreground">Loading templates…</p>}
      {load.kind === "error" && <p role="alert" className="p-2.5 text-sm text-destructive">{load.message}</p>}
      {load.kind === "ready" && load.templates.length === 0 && <NoTemplates />}
      {load.kind === "ready" && load.templates.map((candidate) => (
        <button key={candidate.name} type="button" onClick={() => choose(candidate)} className="flex min-h-11 w-full flex-col items-start rounded-lg px-2.5 py-2 text-left hover:bg-accent">
          <span className="text-sm font-medium">{candidate.name} <span className="font-normal text-muted-foreground">· {candidate.role} · {candidate.scope}</span></span>
          {candidate.description && <span className="mt-0.5 text-xs text-muted-foreground">{candidate.description}</span>}
        </button>
      ))}
    </WorkbenchPopover>

    <Dialog open={template !== null} onClose={() => { if (!submitting) setTemplate(null); }} title={`New ${template?.name ?? ""} thread`}
      description={template?.description} className="w-[min(32rem,calc(100vw-2rem))]">
      {template && <ThreadStartForm key={template.name} project={project} session={session} templates={[template]}
        onSubmitting={setSubmitting} onCancel={() => setTemplate(null)} onStarted={() => { setTemplate(null); onStarted(); }} />}
    </Dialog>
  </>;
}

export function NoTemplates() {
  return <p className="p-2.5 text-sm text-muted-foreground">No templates yet. Ask a coordinator to save one with <code>hp template save</code>.</p>;
}

/**
 * Name a thread and its task and start it under the project's root or one of its open coordinators
 * (Organizations' `node start`). With more than one template the form offers the choice.
 */
export function ThreadStartForm({ project, session, templates, onStarted, onCancel, onSubmitting, readOnly = false }: {
  project: ProjectView;
  session?: string;
  templates: readonly TemplateView[];
  onStarted: () => void;
  onCancel?: () => void;
  onSubmitting?: (submitting: boolean) => void;
  readOnly?: boolean;
}) {
  const [template, setTemplate] = useState(templates[0]?.name ?? "");
  const [form, setForm] = useState<StartForm>({ title: templates.length === 1 ? templates[0].name : "", parent: "root", task: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = (next: boolean) => {
    setSubmitting(next);
    onSubmitting?.(next);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!template || readOnly) return;
    busy(true);
    setError(null);
    try {
      await startOrgNode({ project: project.slug, template, ...form }, session);
      busy(false);
      onStarted();
    } catch (failure) {
      setError(errorMessage(failure));
      busy(false);
    }
  }

  const parents = project.threads.filter((thread) => thread.role === "coordinator" && thread.status === "open");
  const set = (key: keyof StartForm) => (event: { currentTarget: { value: string } }) => {
    const value = event.currentTarget.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <form className="mt-4 space-y-3" onSubmit={(event) => void submit(event)}>
      {templates.length > 1 && <label className="block text-sm font-medium">Template
        <select className={FIELD} value={template} onChange={(event) => setTemplate(event.currentTarget.value)}>
          {templates.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name} · {candidate.role} · {candidate.scope}</option>)}
        </select>
      </label>}
      <label className="block text-sm font-medium">Title
        <input className={FIELD} value={form.title} required onChange={set("title")} />
      </label>
      {parents.length > 0 && <label className="block text-sm font-medium">Parent
        <select className={FIELD} value={form.parent} onChange={set("parent")}>
          <option value="root">Project root</option>
          {parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.id} · {parent.title}</option>)}
        </select>
      </label>}
      <label className="block text-sm font-medium">Task
        <textarea className={`${FIELD} min-h-32 py-2`} value={form.task} required onChange={set("task")} />
      </label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && <Button type="button" size="lg" variant="ghost" className="text-sm" disabled={submitting} onClick={onCancel}>Cancel</Button>}
        <Button type="submit" size="lg" className="text-sm" disabled={submitting || readOnly}>{submitting ? "Starting…" : "Start thread"}</Button>
      </div>
    </form>
  );
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Request failed.";
  const start = error.message.indexOf("{");
  if (start >= 0) {
    try {
      const body: unknown = JSON.parse(error.message.slice(start));
      if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return body.error;
    } catch {
      // Keep the transport's original message when its response was not JSON.
    }
  }
  return error.message;
}
