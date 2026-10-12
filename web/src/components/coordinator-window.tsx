import { useEffect, useState, type FormEvent } from "react";

import { Field, Segmented } from "@/components/new-agent-sheet";
import { inputField } from "@/components/ui/field";
import { SelectField } from "@/components/ui/select-field";
import { errorMessage } from "@/components/node-start";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { fetchCoordinatorChoices, type CoordinatorChoice, type CoordinatorChoices } from "@/lib/api";
import { cn } from "@/lib/utils";

/** What the window is filled in with: the profile it starts from, its harness, and the model and effort over it. */
interface Form { profile: string; harness: string; model: string; effort: string }

const HARNESS_NAME: Record<string, string> = {
  claude: "Claude Code", codex: "Codex", copilot: "Copilot CLI", cursor: "Cursor", gemini: "Gemini CLI", opencode: "OpenCode", omp: "oh-my-pi", pi: "pi",
};
const harnessName = (kind: string) => HARNESS_NAME[kind] ?? kind;
/** The bridge's own check (org-cli.ts MODEL_RE): one model name, never a flag. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,127}$/;

type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; choices: CoordinatorChoices };

/**
 * The window Start coordinator and Replace coordinator open: which harness the coordinator runs, which
 * model (any, typed; the harness's default as the hint) and which effort, with the last launch (or, to
 * replace, the running one) chosen already. A saved profile with its own model is one tap. Against an
 * Organizations that cannot choose more, it offers the profile names, as Nenu always did.
 */
export function CoordinatorWindow({ project, session, mode, running, busy = false, error, onSubmit, onClose }: {
  project: string;
  session?: string;
  mode: "start" | "replace";
  /** The running coordinator's harness, chosen first when there is no last launch. */
  running?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (choice: CoordinatorChoice) => void;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => {
    let current = true;
    fetchCoordinatorChoices(project, session).then(
      (choices) => {
        if (!current) return;
        setLoaded({ kind: "ready", choices });
        setForm(firstForm(choices, mode, running));
      },
      (failure: unknown) => { if (current) setLoaded({ kind: "error", message: errorMessage(failure) }); },
    );
    return () => { current = false; };
  }, [project, session, mode, running]);

  const choices = loaded.kind === "ready" ? loaded.choices : null;
  const own = choices?.harnesses.find((harness) => harness.harness === form?.harness);
  const shortcut = shortcutOf(choices, form);
  // A phone's keyboard may leave a space after a word; anything else that is not one name is refused.
  const badModel = !!form?.model.trim() && !MODEL_RE.test(form.model.trim());
  // Replacing needs a choice; starting falls back to the project's default when the choices are unavailable.
  const ready = mode === "start" ? !badModel : !!form && !badModel && !!(form.profile || form.harness);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    onSubmit(choices && form ? choiceOf({ ...form, model: form.model.trim() }, choices, mode) : {});
  }

  const pick = (harness: string) => {
    const profile = choices?.harnesses.find((candidate) => candidate.harness === harness)?.profile ?? harness;
    setForm({ profile, harness, model: "", effort: "" });
  };

  return (
    <BottomSheet open onClose={() => { if (!busy) onClose(); }} title={mode === "start" ? "Start the coordinator" : "Replace the coordinator?"} className="lg:max-w-[26rem]">
      <form className="flex flex-col gap-4 px-4 pt-1 pb-4" onSubmit={submit}>
        {mode === "replace" && <p className="text-footnote text-muted-foreground">The running coordinator stops and its conversation ends. A new one starts in the same Herdr session.</p>}
        {loaded.kind === "loading" && <p className="text-footnote text-muted-foreground">Reading what this project's coordinator can run…</p>}
        {loaded.kind === "error" && <p role="alert" className="text-footnote text-muted-foreground">
          The choices are unavailable: {loaded.message}{mode === "start" ? " Start runs the project's default." : ""}
        </p>}

        {choices && form && !choices.available && <Field label="Runs on">
          <SelectField value={form.profile} onChange={(event) => setForm({ ...form, profile: event.currentTarget.value })}>
            {mode === "start" && <option value="">The project's default</option>}
            {choices.profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}
          </SelectField>
        </Field>}

        {choices?.available && form && <>
          <div className="flex flex-col gap-1.5">
            <span className="text-footnote font-medium text-muted-foreground">Harness</span>
            <Segmented label="Harness" className="flex-wrap" value={form.harness} onChange={pick}
              options={choices.harnesses.map((harness) => ({ id: harness.harness, label: harnessName(harness.harness) }))} />
          </div>
          {shortcuts(choices).length > 0 && <div className="flex flex-col gap-1.5">
            <span className="text-footnote font-medium text-muted-foreground">Saved profiles</span>
            <div className="flex flex-wrap gap-1.5">
              {shortcuts(choices).map((profile) => (
                <button key={profile.name} type="button" aria-pressed={shortcut?.name === profile.name}
                  onClick={() => setForm({ profile: profile.name, harness: profile.harness, model: profile.model, effort: profile.reasoningEffort })}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-left text-footnote transition-colors hover:bg-accent aria-pressed:border-foreground/40 aria-pressed:bg-accent coarse:min-h-11">
                  <span className="font-medium">{profile.name}</span>
                  <span className="text-muted-foreground"> · {[harnessName(profile.harness), profile.model, profile.reasoningEffort].filter(Boolean).join(" · ")}</span>
                </button>
              ))}
            </div>
          </div>}
          <Field label="Model">
            <input className={cn(inputField, badModel && "border-destructive")} value={form.model} spellCheck={false} autoCapitalize="none" autoComplete="off"
              aria-invalid={badModel || undefined} placeholder={shortcut?.model || own?.defaultModel || "The harness's default"}
              onChange={(event) => setForm({ ...form, model: event.currentTarget.value })} />
          </Field>
          {badModel && <p className="-mt-2.5 text-footnote text-destructive">One model name, like opus or gpt-5.5.</p>}
          {own && own.efforts.length > 0 && <Field label="Effort">
            <SelectField value={form.effort} onChange={(event) => setForm({ ...form, effort: event.currentTarget.value })}>
              <option value="">The {shortcut ? "profile's" : "harness's"} default</option>
              {own.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </SelectField>
          </Field>}
        </>}

        {error && <p role="alert" className="text-footnote text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="lg" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={mode === "start" ? "default" : "destructive"} size="lg" disabled={!ready || busy || loaded.kind === "loading"} aria-busy={busy || undefined}>
            {mode === "start" ? "Start" : busy ? "Replacing…" : "Replace"}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

/**
 * The saved profiles that are more than a harness's own: a model, an effort or arguments of their own.
 * One may be allowed when its harness is not, so it is offered whether or not that harness is.
 */
function shortcuts(choices: CoordinatorChoices) {
  return choices.profiles.filter((profile) => !choices.harnesses.some((harness) => harness.profile === profile.name));
}

function shortcutOf(choices: CoordinatorChoices | null, form: Form | null) {
  return choices && form ? shortcuts(choices).find((profile) => profile.name === form.profile) ?? null : null;
}

/** The last launch, else the running coordinator's harness or the project's default, else the first harness. */
function firstForm(choices: CoordinatorChoices, mode: "start" | "replace", running?: string): Form {
  if (!choices.available) {
    const name = mode === "replace" ? choices.profiles.find((profile) => profile.name === running)?.name ?? choices.profiles[0]?.name ?? "" : "";
    return { profile: name, harness: "", model: "", effort: "" };
  }
  const own = (harness: string) => choices.harnesses.find((candidate) => candidate.harness === harness);
  const last = choices.last;
  const lastSaved = shortcuts(choices).find((profile) => profile.name === last?.profile);
  const lastOwn = last && own(last.harness);
  if (last && (lastSaved || lastOwn)) {
    return { profile: lastSaved?.name ?? lastOwn!.profile, harness: last.harness, model: last.model, effort: last.reasoningEffort };
  }
  const named = choices.profiles.find((profile) => profile.name === (mode === "replace" && running && own(running) ? own(running)!.profile : choices.defaultProfile));
  if (named && own(named.harness)) {
    const saved = shortcuts(choices).some((profile) => profile.name === named.name);
    return { profile: named.name, harness: named.harness, model: saved ? named.model : "", effort: saved ? named.reasoningEffort : "" };
  }
  const first = choices.harnesses[0];
  return { profile: first?.profile ?? "", harness: first?.harness ?? "", model: "", effort: "" };
}

/**
 * What to ask for: a saved profile with only what the person changed on it; a harness with its model
 * and effort; nothing at all when that is the project's default as it stands, so `open` runs as before.
 */
function choiceOf(form: Form, choices: CoordinatorChoices, mode: "start" | "replace"): CoordinatorChoice {
  if (!choices.available) return form.profile ? { profile: form.profile } : {};
  const saved = shortcutOf(choices, form);
  if (saved) {
    return {
      profile: saved.name,
      ...(form.model && form.model !== saved.model ? { model: form.model } : {}),
      ...(form.effort && form.effort !== saved.reasoningEffort ? { effort: form.effort } : {}),
    };
  }
  if (mode === "start" && form.profile === choices.defaultProfile && !form.model && !form.effort) return {};
  return { harness: form.harness, ...(form.model ? { model: form.model } : {}), ...(form.effort ? { effort: form.effort } : {}) };
}
