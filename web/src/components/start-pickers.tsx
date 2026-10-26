import { useState, type KeyboardEvent, type ReactNode } from "react";

import { AgentIcon } from "@/components/agent-icon";
import { AppWindow, Check, FolderPlus, Layers, LayoutTemplate, Search, Sparkle, type IconComponent } from "@/components/ui/icon";
import { QuietMenu, quietMenuItem } from "@/components/ui/quiet-menu";
import type { StartModels } from "@/lib/api";
import { workspaceName } from "@/lib/spaces";
import { agentLabel, DEFAULT_MODEL } from "@/lib/spawn";
import {
  BY_FOLDER, destinationLabel, sameDestination, tabPlace,
  type Places, type StartDestination,
} from "@/lib/start-destination";
import { cn } from "@/lib/utils";

export type StartAgent = keyof StartModels;
const AGENTS: readonly StartAgent[] = ["claude", "codex"];

// Each agent's mark as a component of its own: one made during a render would be a new type on every
// poll, and React would swap its DOM each time.
const AGENT_MARKS: Record<StartAgent, IconComponent> = {
  claude: ({ className }) => <AgentIcon agent="claude" className={cn(className, "size-4")} />,
  codex: ({ className }) => <AgentIcon agent="codex" className={cn(className, "size-4")} />,
};

const matches = (query: string, ...words: string[]) => {
  const q = query.trim().toLowerCase();
  return !q || words.some((word) => word.toLowerCase().includes(q));
};

/** The search field at the top of a picker; Enter takes the first row a search leaves, and with nothing typed keeps the choice. */
function MenuSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const row = value.trim() ? '[role="menuitemradio"]' : '[role="menuitemradio"][aria-checked="true"]';
    event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>(row)?.click();
  };
  return (
    <div className="sticky top-0 z-10 -mx-1 -mt-1 mb-1 flex items-center gap-2 border-b border-border bg-popover px-3">
      <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input data-autofocus type="search" aria-label={placeholder} placeholder={placeholder} value={value} onKeyDown={onKey}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 min-w-0 flex-1 bg-transparent text-subhead outline-none placeholder:text-muted-foreground coarse:h-11" />
    </div>
  );
}

function Group({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode[] }) {
  if (!children.length) return null;
  return (
    <div role="group" aria-label={label} className="flex flex-col pb-1">
      <p aria-hidden className="flex items-center gap-2 px-2.5 pt-1.5 pb-1 text-caption font-medium text-muted-foreground">{icon}{label}</p>
      {children}
    </div>
  );
}

function Row({ checked, label, hint, icon, onPick }: { checked: boolean; label: string; hint?: string; icon?: ReactNode; onPick: () => void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} onClick={onPick} className={cn(quietMenuItem, "py-1.5")}>
      <Check aria-hidden className={cn("size-4 shrink-0", !checked && "invisible")} />
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{label}</span>
        {hint && <span className="truncate text-footnote text-muted-foreground">{hint}</span>}
      </span>
    </button>
  );
}

const Empty = () => <p className="px-2.5 py-2 text-footnote text-muted-foreground">Nothing matches.</p>;

const modelOf = (models: StartModels, agent: StartAgent, id: string) => models[agent].find((m) => m.id === id);

/**
 * The agent and the model it starts on, in one searchable menu grouped by agent. The chip names the
 * agent while it runs on its default and the model once one is chosen; `agents` narrows it to one,
 * whose chip then names only the model.
 */
export function ModelMenu({ models, agent, model, onPick, agents = AGENTS, disabled }: {
  models: StartModels;
  agent: StartAgent;
  model: string;
  onPick: (agent: StartAgent, model: string) => void;
  agents?: readonly StartAgent[];
  disabled?: boolean;
}) {
  const chosen = modelOf(models, agent, model);
  const onDefault = !chosen || chosen.id === DEFAULT_MODEL;
  // Beside an agent chosen elsewhere (the New flow's segments) the chip names only the model.
  const label = agents.length > 1 ? (onDefault ? agentLabel(agent) : chosen.label) : onDefault ? "Default model" : chosen.label;
  return (
    <QuietMenu icon={AGENT_MARKS[agent]} label={label} ariaLabel={`Model: ${agentLabel(agent)}, ${chosen?.label ?? "Default"}`} menuLabel="Model"
      disabled={disabled} menuClassName="w-80 max-w-[calc(100vw-2rem)] max-h-[min(26rem,60dvh)] overflow-y-auto">
      {(close) => <ModelRows models={models} agent={agent} model={model} agents={agents} onPick={(a, m) => { onPick(a, m); close(); }} />}
    </QuietMenu>
  );
}

function ModelRows({ models, agent, model, agents, onPick }: { models: StartModels; agent: StartAgent; model: string; agents: readonly StartAgent[]; onPick: (agent: StartAgent, model: string) => void }) {
  const [query, setQuery] = useState("");
  const shown = agents.map((a) => [a, models[a].filter((m) => matches(query, m.label, m.id, m.hint, agentLabel(a)))] as const);
  return (
    <>
      <MenuSearch value={query} onChange={setQuery} placeholder="Search models" />
      {shown.map(([a, rows]) => (
        <Group key={a} label={agentLabel(a)} icon={<AgentIcon agent={a} className="size-3.5" />}>
          {rows.map((m) => <Row key={m.id} checked={a === agent && m.id === model} label={m.label} hint={m.hint} onPick={() => onPick(a, m.id)} />)}
        </Group>
      ))}
      {shown.every(([, rows]) => !rows.length) && <Empty />}
    </>
  );
}

const DESTINATION_ICONS: Record<StartDestination["kind"], IconComponent> = {
  folder: Layers,
  quick: Sparkle,
  workspace: FolderPlus,
  tab: AppWindow,
  pane: LayoutTemplate,
};

/**
 * Where the chat opens, in one searchable menu: by the chosen folder, a quick chat, a new workspace,
 * a new tab of a live workspace or a new pane beside a live tab's (lib/start-destination).
 */
export function DestinationMenu({ places, destination, onPick, disabled }: {
  places: Places;
  destination: StartDestination;
  onPick: (destination: StartDestination) => void;
  disabled?: boolean;
}) {
  const label = destinationLabel(destination, places);
  return (
    <QuietMenu icon={DESTINATION_ICONS[destination.kind]} label={<span className="block max-w-56 truncate">{label}</span>} ariaLabel={`Opens: ${label}`}
      menuLabel="Where it opens" className="min-w-0" disabled={disabled}
      menuClassName="w-80 max-w-[calc(100vw-2rem)] max-h-[min(26rem,60dvh)] overflow-y-auto">
      {(close) => <DestinationRows places={places} destination={destination} onPick={(next) => { onPick(next); close(); }} />}
    </QuietMenu>
  );
}

function DestinationRows({ places, destination, onPick }: { places: Places; destination: StartDestination; onPick: (destination: StartDestination) => void }) {
  const [query, setQuery] = useState("");
  const row = (next: StartDestination, label: string, hint: string, key: string = next.kind) => {
    const Icon = DESTINATION_ICONS[next.kind];
    return matches(query, label, hint)
      ? [<Row key={key} checked={sameDestination(next, destination)} label={label} hint={hint}
          icon={<Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />} onPick={() => onPick(next)} />]
      : [];
  };
  const start = [
    ...row(BY_FOLDER, "By folder", "Joins the workspace in this folder, else opens one"),
    ...row({ kind: "quick" }, "Quick chat", "A tab of the scratch workspace on ~, nothing to clean up"),
    ...row({ kind: "workspace" }, "New workspace", "A workspace of its own on this folder"),
  ];
  const workspaces = places.workspaces.flatMap((w) => row({ kind: "tab", workspaceId: w.workspaceId }, workspaceName(w), "A new tab in this workspace", `w:${w.workspaceId}`));
  const tabs = places.tabs.flatMap((t) => row({ kind: "pane", tabId: t.tabId }, tabPlace(t, places), "A new pane beside this tab's", `t:${t.tabId}`));
  return (
    <>
      <MenuSearch value={query} onChange={setQuery} placeholder="Search workspaces and tabs" />
      <Group label="Start">{start}</Group>
      <Group label="In a workspace">{workspaces}</Group>
      <Group label="In a tab">{tabs}</Group>
      {!start.length && !workspaces.length && !tabs.length && <Empty />}
    </>
  );
}
