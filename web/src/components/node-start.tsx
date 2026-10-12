import { useEffect, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { useRevalidator } from "react-router";

import { Field, Segmented, openNewDialog, useOnScreen } from "@/components/new-agent-sheet";
import { Button } from "@/components/ui/button";
import { inputField, textField } from "@/components/ui/field";
import { SelectField } from "@/components/ui/select-field";
import { fetchOrgStartOptions, startOrgNode } from "@/lib/api";
import type { NodeRole, ProjectView, TemplateView } from "@/lib/types";
import { cn } from "@/lib/utils";

type StartOptions =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; templates: TemplateView[]; profiles: string[] };

type StartForm = { title: string; parent: string; task: string; profile: string; template: string };

const ROLE_NOUN: Record<NodeRole, string> = { worker: "thread", coordinator: "coordinator" };
const ROLES: ReadonlyArray<{ id: NodeRole; label: string }> = [{ id: "worker", label: "Thread" }, { id: "coordinator", label: "Coordinator" }];

/**
 * The roles a project can start: none while it is paused (Organizations refuses), and no
 * coordinator under upstream herdr-projects, which has no nodes.
 */
export function startableRoles(project: ProjectView): NodeRole[] {
  if (project.status === "paused") return [];
  return project.nodeActions === false ? ["worker"] : ["worker", "coordinator"];
}

/** A project's templates and the profiles a node can run, read once the form is on screen. */
export function useStartOptions(project: string, session: string | undefined): StartOptions {
  const [options, setOptions] = useState<StartOptions>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    setOptions({ kind: "loading" });
    fetchOrgStartOptions(project, session).then(
      ({ templates, profiles }) => { if (current) setOptions({ kind: "ready", templates, profiles }); },
      (failure: unknown) => { if (current) setOptions({ kind: "error", message: errorMessage(failure) }); },
    );
    return () => { current = false; };
  }, [project, session]);
  return options;
}

/**
 * "New thread" and "New coordinator" for a project, each opening the one New flow on that project
 * and role. The page that shows them refreshes through `onStarted`, so starting never navigates away.
 */
export function NewNodeActions({ project, onStarted }: {
  project: ProjectView;
  /** The New flow starts in the snapshot's session, which is the page's. */
  session?: string;
  onStarted: () => void;
}) {
  const roles = startableRoles(project);
  if (roles.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((role) => (
        <button key={role} type="button" className="quiet-action" aria-haspopup="dialog"
          onClick={() => openNewDialog({ kind: "thread", project: project.slug, role, onStarted })}>
          <Plus aria-hidden className="size-4" />New {ROLE_NOUN[role]}
        </button>
      ))}
    </div>
  );
}

/**
 * Name a thread or coordinator and its task, and start it under the project's root or one of its
 * open coordinators (Organizations' `node start`), with a profile or from a template when the host
 * has them. `onRole` adds the Thread/Coordinator switch; without it the role is the caller's.
 */
export function NodeStartForm({ project, session, role, onRole, onStarted, readOnly = false }: {
  project: ProjectView;
  session?: string;
  role: NodeRole;
  onRole?: (role: NodeRole) => void;
  onStarted: () => void;
  readOnly?: boolean;
}) {
  const options = useStartOptions(project.slug, session);
  const revalidator = useRevalidator();
  const onScreen = useOnScreen();
  const [form, setForm] = useState<StartForm>({ title: "", parent: "root", task: "", profile: "", template: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roles = startableRoles(project);
  const templates = options.kind === "ready" ? options.templates.filter((candidate) => candidate.role === role) : [];
  const profiles = options.kind === "ready" ? options.profiles : [];
  // A template chosen under the other role no longer applies once the role switches.
  const template = templates.some((candidate) => candidate.name === form.template) ? form.template : "";
  // Nesting comes with coordinators: a host that cannot start one cannot start under one either.
  const parents = roles.includes("coordinator") ? project.threads.filter((thread) => thread.role === "coordinator" && thread.status === "open") : [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly) return;
    setSubmitting(true);
    setError(null);
    try {
      const { title, parent, task, profile } = form;
      await startOrgNode({ project: project.slug, role, title, parent, task, ...(template ? { template } : profile ? { profile } : {}) }, session);
      if (!onScreen.current) {
        void revalidator.revalidate();
        return;
      }
      setSubmitting(false);
      onStarted();
    } catch (failure) {
      setError(errorMessage(failure));
      setSubmitting(false);
    }
  }

  const set = (key: keyof StartForm) => (event: { currentTarget: { value: string } }) => {
    const value = event.currentTarget.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      {onRole && roles.length > 1 && <Segmented label="Role" options={ROLES.filter((option) => roles.includes(option.id))} value={role} onChange={onRole} />}
      <Field label="Title">
        <input className={inputField} value={form.title} required onChange={set("title")} data-autofocus />
      </Field>
      {parents.length > 0 && <Field label="Parent">
        <SelectField value={form.parent} onChange={set("parent")}>
          <option value="root">Project root</option>
          {parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.title}</option>)}
        </SelectField>
      </Field>}
      {/* On screen while the names load, so the form does not jump under the person's typing. */}
      {!template && <Field label="Profile">
        <SelectField value={form.profile} disabled={options.kind === "loading"} onChange={set("profile")}>
          <option value="">Project default</option>
          {profiles.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
        </SelectField>
      </Field>}
      {templates.length > 0 && <Field label="Template">
        <SelectField value={template} onChange={set("template")}>
          <option value="">None</option>
          {templates.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name} · {candidate.scope}</option>)}
        </SelectField>
      </Field>}
      <Field label="Task">
        <textarea className={cn(textField, "min-h-32 resize-y")} value={form.task} required onChange={set("task")} />
      </Field>
      {options.kind === "error" && <p className="text-footnote text-muted-foreground">Profiles and templates are unavailable: {options.message}</p>}
      {error && <p role="alert" className="text-subhead text-destructive">{error}</p>}
      <Button type="submit" className="mt-1 h-11" disabled={submitting || readOnly} aria-busy={submitting || undefined}>
        {submitting ? "Starting…" : `Create ${ROLE_NOUN[role]}`}
      </Button>
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
