import { useState } from "react";
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

const TICK_STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 240];
const LABEL_W = 160;

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-lg font-semibold tabular-nums tracking-tight">{value}</span>
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
    </div>
  );
}

/** Each agent as a bar on one shared clock, grouped by phase, so what ran in parallel shows. */
export function WorkflowTimeline({ workflow, now, selectedAgentId, onSelectAgent }: { workflow: ActivityWorkflow; now: number; selectedAgentId?: string | null; onSelectAgent?: (id: string) => void }) {
  const agents = allAgents(workflow);
  const starts = agents.flatMap((a) => a.startedAt ?? []);
  const t0 = workflow.startedAt ?? (starts.length ? Math.min(...starts) : undefined);
  if (t0 === undefined || !agents.length) return <p className="text-xs text-muted-foreground">No timing recorded yet.</p>;
  const end = (a: ActivityAgent) => (a.startedAt ?? t0) + (agentElapsed(a, now) ?? 0);
  const t1 = workflow.status === "running" ? now : Math.max(t0 + (workflow.durationMs ?? 0), ...agents.map(end));
  const span = Math.max(1, t1 - t0);
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - t0) / span) * 100))}%`;
  const stepMin = TICK_STEPS_MIN.find((m) => span / (m * 60_000) <= 7) ?? 480;
  const step = stepMin * 60_000;
  const ticks: number[] = [];
  // A tick hard against either edge would be clipped by the track, so those are left out.
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) if ((t - t0) / span > 0.03 && (t1 - t) / span > 0.05) ticks.push(t);
  return (
    <div className="overflow-x-auto">
      <div className="relative flex min-w-[560px] flex-col gap-0.5">
        <div className="flex h-6 items-center">
          <span className="shrink-0 pl-3 text-[11.5px] text-muted-foreground" style={{ width: LABEL_W }}>Agent</span>
          <span className="relative h-6 flex-1">
            {ticks.map((t) => <span key={t} className="absolute top-1 -translate-x-1/2 font-mono text-[11px] text-muted-foreground" style={{ left: pct(t) }}>{formatClock(t)}</span>)}
          </span>
        </div>
        {workflow.phases.map((phase) => (
          <div key={phase.title} className="flex flex-col gap-0.5">
            <div className="flex h-7 items-center gap-2 px-3 text-xs font-medium">
              {phaseRunning(phase) ? <StateDot state="running" /> : <Check aria-hidden="true" className="size-3 text-status-done" />}
              <span>{phase.title || "Agents"}</span>
              <span className="font-normal text-muted-foreground">{phaseDone(phase)}/{phase.agents.length} done</span>
            </div>
            {phase.agents.map((agent) => {
              const start = agent.startedAt ?? t0;
              const on = agent.id === selectedAgentId;
              return (
                <button
                  key={agent.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onSelectAgent?.(agent.id)}
                  className={cn("flex h-7 items-center rounded-md text-left hover:bg-muted/40", on && "bg-muted")}
                >
                  <span className="flex shrink-0 items-center gap-2 overflow-hidden pl-3 pr-2 text-[12.5px]" style={{ width: LABEL_W }}>
                    <StateDot state={agent.state} /><span className="truncate">{agent.label}</span>
                  </span>
                  <span className="relative h-7 flex-1">
                    <span
                      className={cn("absolute top-[9px] h-2.5 min-w-1.5 rounded-full", agent.state === "running" ? "bg-gradient-to-r from-status-working/50 to-status-working" : agent.state === "failed" ? "bg-destructive/60" : on ? "bg-status-done/85" : "bg-status-done/55")}
                      style={{ left: pct(start), width: `calc(${pct(end(agent))} - ${pct(start)})` }}
                    />
                  </span>
                  <span className={cn("w-16 shrink-0 pl-2 text-[11.5px] tabular-nums", agent.state === "running" ? "text-status-working" : "text-muted-foreground")}>
                    {formatDuration(agentElapsed(agent, now))}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
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
        <div key={i} className="flex gap-2 text-[12.5px] leading-relaxed"><span aria-hidden="true" className="text-muted-foreground">·</span><span className="min-w-0 break-words">{brief(item)}</span></div>
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
  if (typeof value === "string") return <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{value}</p>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return <pre className="whitespace-pre-wrap break-words font-mono text-xs">{brief(value)}</pre>;
  const entries = Object.entries(value as Record<string, unknown>);
  const short = entries.filter(([, v]) => (typeof v === "string" && v.length <= 80 && !v.includes("\n")) || typeof v === "number" || typeof v === "boolean");
  const rest = entries.filter((e) => !short.includes(e));
  return (
    <div className="flex flex-col gap-4">
      {short.length > 0 && (
        <dl className="flex flex-col gap-2">
          {short.map(([k, v]) => (
            <div key={k} className="flex gap-3 text-[12.5px] leading-snug">
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
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{brief(v)}</p>
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
    <aside aria-label={`Agent ${agent.label}`} className="flex min-h-0 flex-col border-t border-border lg:w-[430px] lg:shrink-0 lg:border-l lg:border-t-0">
      <div className="flex flex-col gap-2.5 border-b border-border px-[18px] pb-3 pt-4">
        <div className="flex items-center gap-2">
          <StateDot state={agent.state} className="size-2" />
          <span className="truncate text-[15px] font-semibold">{agent.label}</span>
          <StatusTag status={agent.state === "running" ? "running" : agent.state === "failed" ? "failed" : "completed"} />
          <span className="flex-1" />
          {onClose && <Button variant="ghost" size="icon" aria-label="Close agent" onClick={onClose}><X aria-hidden="true" /></Button>}
        </div>
        <Meta items={[agent.phase, formatDuration(agentElapsed(agent, now)), agent.toolCalls !== undefined ? `${agent.toolCalls} tool calls` : "", agent.tokens !== undefined ? `${formatCount(agent.tokens)} tokens` : "", agent.model ?? ""]} />
      </div>
      <div className="px-[18px] py-4 lg:flex-1 lg:overflow-y-auto">
        {result !== undefined ? <AgentResult value={result} />
          : agent.state === "running" ? <p className="text-[13px] text-muted-foreground">Still working{agent.lastTool ? ` · ${agent.lastTool}` : ""}.</p>
            : <p className="text-[13px] text-muted-foreground">{agent.resultPreview ?? "No result recorded."}</p>}
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
 * A workflow opened from its card: header with totals, one card per phase, the timeline, and the
 * selected agent's result beside it (below it on a phone).
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
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden", className)}>
      <div className="flex min-w-0 flex-col gap-5 px-4 pb-6 pt-5 lg:flex-1 lg:overflow-y-auto lg:px-7 lg:pt-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-[11.5px] font-medium text-muted-foreground"><Workflow aria-hidden="true" className="size-3" />Workflow</span>
              <StatusTag status={workflow.status} />
              {workflow.startedAt !== undefined && <span className="text-xs text-muted-foreground">started {formatClock(workflow.startedAt)} by Claude</span>}
            </div>
            <h1 className="truncate text-2xl font-semibold tracking-tight">{workflow.name}</h1>
            {workflow.summary && <p className="max-w-[560px] text-[13.5px] leading-relaxed text-muted-foreground">{workflow.summary}</p>}
          </div>
          <div className="flex gap-6 lg:pt-1.5">
            <Stat value={`${workflow.doneCount}/${workflow.agentCount}`} label="agents done" />
            <Stat value={formatDuration(workflowElapsed(workflow, now)) || "–"} label={workflow.status === "running" ? "elapsed" : "took"} />
            {workflow.totalToolCalls !== undefined && <Stat value={String(workflow.totalToolCalls)} label="tool calls" />}
            {workflow.totalTokens !== undefined && <Stat value={formatCount(workflow.totalTokens)} label="tokens" />}
          </div>
        </div>
        {workflow.phases.length > 0 && (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(160px,1fr))]">
            {workflow.phases.map((phase) => (
              <div key={phase.title} className={cn("flex flex-col gap-2 rounded-lg bg-card px-3 py-2.5 ring-1", phaseRunning(phase) ? "ring-status-working/30" : "ring-border")}>
                <div className="flex items-center gap-1.5 text-[12.5px]">
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
            <h2 className="text-[13px] font-medium">Timeline</h2>
            <span className="flex-1" />
            {workflow.status === "running" && <span className="text-xs text-muted-foreground">Now {formatClock(now)}</span>}
          </div>
          <WorkflowTimeline workflow={workflow} now={now} selectedAgentId={selectedAgentId} onSelectAgent={(id) => onSelectAgent?.(id === selectedAgentId ? null : id)} />
        </section>
      </div>
      {selected && <AgentPanel agent={selected} result={results[selected.id]} now={now} onClose={onSelectAgent && (() => onSelectAgent(null))} onOpenTranscript={onOpenTranscript} />}
    </div>
  );
}
