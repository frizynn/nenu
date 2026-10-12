import { createContext, useContext, useState } from "react";
import { Check, Copy, MessageSquare, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  agentElapsed,
  allAgents,
  formatClock,
  formatCount,
  formatDuration,
  phaseDone,
  phaseRunning,
  workflowElapsed,
  type ActivityAgent,
  type ActivityWorkflow,
} from "@/lib/activity";
import { AgentBar, Meta, StateDot, StatusTag } from "./activity-parts";

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-headline tabular-nums">{value}</span>
      <span className="text-footnote text-muted-foreground">{label}</span>
    </div>
  );
}

/**
 * Per phase, each agent with what it is doing or returned and how long it took. The detail lives in
 * a side panel or a sheet, never wider than a phone, so agents are a list rather than a timeline.
 */
export function WorkflowAgentList({ workflow, now, selectedAgentId, onSelectAgent }: { workflow: ActivityWorkflow; now: number; selectedAgentId?: string | null; onSelectAgent?: (id: string) => void }) {
  if (!allAgents(workflow).length) return <p className="text-xs text-muted-foreground">No agents recorded yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      {workflow.phases.map((phase) => (
        <div key={phase.title} className="flex flex-col">
          <div className="flex h-7 items-center gap-2 text-xs font-medium">
            {phaseRunning(phase) ? <StateDot state="running" /> : <Check aria-hidden="true" className="size-3 text-status-done" />}
            <span>{phase.title || "Agents"}</span>
            <span className="font-normal text-muted-foreground">{phaseDone(phase)}/{phase.agents.length} done</span>
          </div>
          {phase.agents.map((agent) => {
            const on = agent.id === selectedAgentId;
            const doing = agent.state === "running" ? agent.lastTool : agent.resultPreview ?? agent.lastTool;
            return (
              <button
                key={agent.id}
                type="button"
                aria-pressed={on}
                onClick={() => onSelectAgent?.(agent.id)}
                className={cn("flex min-h-11 items-center gap-2 rounded-md px-2 text-left text-footnote hover:bg-muted/40", on && "bg-muted")}
              >
                <StateDot state={agent.state} />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate font-medium">{agent.label}</span>
                  {doing && <span className="truncate text-xs text-muted-foreground">{doing}</span>}
                </span>
                <span className={cn("shrink-0 text-xs tabular-nums", agent.state === "running" ? "text-status-working" : "text-muted-foreground")}>
                  {formatDuration(agentElapsed(agent, now))}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const humanize = (key: string) => key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const brief = (v: unknown): string => typeof v === "string" ? v : JSON.stringify(v) ?? "";
// Branches, hashes and paths read better in mono; plain words do not.
const looksLikeCode = (s: string) => /^[\w./:@+-]{6,}$/.test(s) && /[\d./:_-]/.test(s);

function ResultList({ label, items }: { label: string; items: unknown[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 2);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label} <span className="font-normal text-muted-foreground/70">{items.length}</span></span>
      {shown.map((item, i) => (
        <div key={i} className="flex gap-2 text-footnote leading-relaxed"><span aria-hidden="true" className="text-muted-foreground">·</span><span className="min-w-0 break-words">{brief(item)}</span></div>
      ))}
      {items.length > 2 && (
        <button type="button" onClick={() => setAll(!all)} className="self-start pl-3.5 text-xs text-muted-foreground hover:text-foreground">
          {all ? "Show less" : `${items.length - 2} more`}
        </button>
      )}
    </div>
  );
}

/** Whatever an agent returned, laid out generically: short fields as rows, long text and lists below. */
export function AgentResult({ value }: { value: unknown }) {
  if (typeof value === "string") return <p className="whitespace-pre-wrap break-words text-footnote leading-relaxed">{value}</p>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return <pre className="whitespace-pre-wrap break-words font-mono text-code">{brief(value)}</pre>;
  const entries = Object.entries(value as Record<string, unknown>);
  const short = entries.filter(([, v]) => (typeof v === "string" && v.length <= 80 && !v.includes("\n")) || typeof v === "number" || typeof v === "boolean");
  const rest = entries.filter((e) => !short.includes(e));
  return (
    <div className="flex flex-col gap-4">
      {short.length > 0 && (
        <dl className="flex flex-col gap-2">
          {short.map(([k, v]) => (
            <div key={k} className="flex gap-3 text-footnote leading-snug">
              <dt className="w-[84px] shrink-0 text-muted-foreground">{humanize(k)}</dt>
              <dd className={cn("min-w-0 break-words", typeof v === "string" && looksLikeCode(v) && "font-mono")}>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {rest.map(([k, v]) => Array.isArray(v)
        ? <ResultList key={k} label={humanize(k)} items={v} />
        : (
          <div key={k} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{humanize(k)}</span>
            <p className="whitespace-pre-wrap break-words text-footnote leading-relaxed">{brief(v)}</p>
          </div>
        ))}
    </div>
  );
}

function AgentPanel({ agent, result, now, onClose, onOpenTranscript }: { agent: ActivityAgent; result: unknown; now: number; onClose?: () => void; onOpenTranscript?: (agentId: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(typeof result === "string" ? result : JSON.stringify(result, null, 2)).then(() => setCopied(true), () => {});
  };
  return (
    <aside aria-label={`Agent ${agent.label}`} className="flex flex-col border-t border-border">
      <div className="flex flex-col gap-2.5 border-b border-border px-[18px] pb-3 pt-4">
        <div className="flex items-center gap-2">
          <StateDot state={agent.state} className="size-2" />
          <span className="truncate text-subhead font-semibold">{agent.label}</span>
          <StatusTag status={agent.state === "running" ? "running" : agent.state === "failed" ? "failed" : "completed"} />
          <span className="flex-1" />
          {onClose && <Button variant="ghost" size="icon" aria-label="Close agent" onClick={onClose}><X aria-hidden="true" /></Button>}
        </div>
        <Meta items={[agent.phase, formatDuration(agentElapsed(agent, now)), agent.toolCalls !== undefined ? `${agent.toolCalls} tool calls` : "", agent.tokens !== undefined ? `${formatCount(agent.tokens)} tokens` : "", agent.model ?? ""]} />
      </div>
      <div className="px-[18px] py-4">
        {result !== undefined ? <AgentResult value={result} />
          : agent.state === "running" ? <p className="text-footnote text-muted-foreground">Still working{agent.lastTool ? ` · ${agent.lastTool}` : ""}.</p>
            : <p className="text-footnote text-muted-foreground">{agent.resultPreview ?? "No result recorded."}</p>}
      </div>
      {(result !== undefined || onOpenTranscript) && (
        <div className="flex gap-2 border-t border-border px-[18px] py-3">
          {onOpenTranscript && <Button variant="outline" size="sm" className="min-h-11 lg:min-h-8" onClick={() => onOpenTranscript(agent.id)}><MessageSquare aria-hidden="true" />Open transcript</Button>}
          {result !== undefined && <Button variant="outline" size="sm" className="min-h-11 lg:min-h-8" onClick={copy}><Copy aria-hidden="true" />{copied ? "Copied" : "Copy result"}</Button>}
        </div>
      )}
    </aside>
  );
}

/**
 * Set by a container whose own heading already names the run (the phone's Processes sheet), so the
 * details don't say the name a second time. The details are built by the chat and handed to that
 * sheet whole, which is why this travels by context rather than as a prop.
 */
export const RunNamedAbove = createContext(false);

/**
 * A workflow's details, shaped for a side panel or a sheet: header with totals, one card per phase,
 * its agents, and the selected agent's result below them.
 */
export function WorkflowDetail({ workflow, results = {}, now, selectedAgentId = null, onSelectAgent, onOpenTranscript, className }: {
  workflow: ActivityWorkflow;
  results?: Record<string, unknown>;
  now: number;
  selectedAgentId?: string | null;
  onSelectAgent?: (id: string | null) => void;
  onOpenTranscript?: (agentId: string) => void;
  className?: string;
}) {
  const selected = selectedAgentId ? allAgents(workflow).find((a) => a.id === selectedAgentId) : undefined;
  const namedAbove = useContext(RunNamedAbove);
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex min-w-0 flex-col gap-5 pb-5">
        <div className="flex flex-col gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-caption font-medium text-muted-foreground"><Workflow aria-hidden="true" className="size-3" />Workflow</span>
              <StatusTag status={workflow.status} />
              {workflow.startedAt !== undefined && <span className="text-xs text-muted-foreground">started {formatClock(workflow.startedAt)} by Claude</span>}
            </div>
            {!namedAbove && <h2 className="truncate text-headline">{workflow.name}</h2>}
            {workflow.summary && <p className="max-w-[560px] text-footnote leading-relaxed text-muted-foreground">{workflow.summary}</p>}
          </div>
          <div className="flex gap-6">
            <Stat value={`${workflow.doneCount}/${workflow.agentCount}`} label="agents done" />
            <Stat value={formatDuration(workflowElapsed(workflow, now)) || "–"} label={workflow.status === "running" ? "elapsed" : "took"} />
            {workflow.totalToolCalls !== undefined && <Stat value={String(workflow.totalToolCalls)} label="tool calls" />}
            {workflow.totalTokens !== undefined && <Stat value={formatCount(workflow.totalTokens)} label="tokens" />}
          </div>
        </div>
        {workflow.phases.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2.5">
            {workflow.phases.map((phase) => (
              <div key={phase.title} className={cn("flex flex-col gap-2 rounded-lg bg-card px-3 py-2.5 ring-1", phaseRunning(phase) ? "ring-status-working/30" : "ring-border")}>
                <div className="flex items-center gap-1.5 text-footnote">
                  {phaseRunning(phase) ? <StateDot state="running" /> : <Check aria-hidden="true" className="size-3 text-status-done" />}
                  <span className="font-medium">{phase.title || "Agents"}</span>
                  <span className="flex-1" />
                  <span className="tabular-nums text-muted-foreground">{phaseDone(phase)}/{phase.agents.length}</span>
                </div>
                <AgentBar states={phase.agents.map((a) => a.state)} className="h-1" />
              </div>
            ))}
          </div>
        )}
        <section className="flex flex-col gap-2.5">
          <div className="flex items-center">
            <h3 className="text-footnote font-medium">Agents</h3>
            <span className="flex-1" />
            {workflow.status === "running" && <span className="text-xs text-muted-foreground">Now {formatClock(now)}</span>}
          </div>
          <WorkflowAgentList workflow={workflow} now={now} selectedAgentId={selectedAgentId} onSelectAgent={(id) => onSelectAgent?.(id === selectedAgentId ? null : id)} />
        </section>
      </div>
      {selected && <AgentPanel agent={selected} result={results[selected.id]} now={now} onClose={onSelectAgent && (() => onSelectAgent(null))} onOpenTranscript={onOpenTranscript} />}
    </div>
  );
}
