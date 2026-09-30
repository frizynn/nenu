import { useEffect, useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fetchOrgTemplates, startOrgNode } from "@/lib/api";
import type { ProjectView, TemplateView } from "@/lib/types";

type TemplateLoad =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; templates: TemplateView[] };

type StartForm = { title: string; parent: string; task: string };

export function OrgTemplates({
  project,
  session,
  readOnly,
  onChanged,
}: {
  project: ProjectView;
  session?: string;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [load, setLoad] = useState<TemplateLoad>({ kind: "loading" });
  const [openName, setOpenName] = useState<string | null>(null);
  const [form, setForm] = useState<StartForm>({ title: "", parent: "root", task: "" });
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoad({ kind: "loading" });
    fetchOrgTemplates(project.slug, session).then(
      (response) => { if (current) setLoad({ kind: "ready", templates: response.templates }); },
      (error: unknown) => { if (current) setLoad({ kind: "error", message: errorMessage(error) }); },
    );
    return () => { current = false; };
  }, [project.slug, session]);

  function openForm(template: TemplateView) {
    setOpenName(template.name);
    setForm({ title: template.name, parent: "root", task: "" });
    setActionError(null);
  }

  function closeForm() {
    setOpenName(null);
    setActionError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>, template: TemplateView) {
    event.preventDefault();
    setSubmitting(true);
    setActionError(null);
    try {
      await startOrgNode({
        project: project.slug,
        template: template.name,
        title: form.title,
        parent: form.parent,
        task: form.task,
      }, session);
      setOpenName(null);
      onChanged();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  if (load.kind === "loading") return <p className="text-sm text-muted-foreground">Loading templates…</p>;
  if (load.kind === "error") return <p role="alert" className="text-sm text-destructive">{load.message}</p>;
  if (load.templates.length === 0) {
    return <p className="text-sm text-muted-foreground">No templates yet. Ask a coordinator to save one with <code>hp template save</code>.</p>;
  }

  const parents = project.threads.filter((thread) => thread.role === "coordinator" && thread.status === "open");

  return <div className="space-y-3">
    {load.templates.map((template) => <Card key={template.name} className="gap-4 p-4 shadow-none">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-sm font-semibold">{template.name}</h3>
            <Badge variant="outline">{template.scope}</Badge>
            <Badge variant="secondary">{template.role}</Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{template.description}</p>
          {template.memoryChars > 0 && <p className="mt-1 text-xs text-muted-foreground">memory {template.memoryChars} chars</p>}
        </div>
        {!readOnly && <Button type="button" size="lg" variant="secondary" onClick={() => openForm(template)}>Open</Button>}
      </div>

      {!readOnly && openName === template.name && <form className="space-y-3 border-t pt-4" onSubmit={(event) => void submit(event, template)}>
        <label className="block text-sm font-medium" htmlFor={`org-title-${template.name}`}>Title
          <input
            id={`org-title-${template.name}`}
            className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-sm font-normal"
            value={form.title}
            required
            onChange={(event) => {
              const title = event.currentTarget.value;
              setForm((current) => ({ ...current, title }));
            }}
          />
        </label>
        <label className="block text-sm font-medium" htmlFor={`org-parent-${template.name}`}>Parent
          <select
            id={`org-parent-${template.name}`}
            className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-sm font-normal"
            value={form.parent}
            onChange={(event) => {
              const parent = event.currentTarget.value;
              setForm((current) => ({ ...current, parent }));
            }}
          >
            <option value="root">root</option>
            {parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.id} · {parent.title}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium" htmlFor={`org-task-${template.name}`}>Task
          <textarea
            id={`org-task-${template.name}`}
            className="mt-1 min-h-32 w-full rounded-md border bg-background px-3 py-2 text-sm font-normal"
            value={form.task}
            required
            onChange={(event) => {
              const task = event.currentTarget.value;
              setForm((current) => ({ ...current, task }));
            }}
          />
        </label>
        {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="lg" disabled={submitting}>{submitting ? "Starting…" : "Start"}</Button>
          <Button type="button" size="lg" variant="outline" disabled={submitting} onClick={closeForm}>Cancel</Button>
        </div>
      </form>}
    </Card>)}
  </div>;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Request failed.";
  const start = error.message.indexOf("{");
  if (start >= 0) {
    try {
      const body: unknown = JSON.parse(error.message.slice(start));
      if (isRecord(body) && typeof body.error === "string") return body.error;
    } catch {
      // Keep the transport's original message when its response was not JSON.
    }
  }
  return error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
