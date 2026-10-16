import { useState, type ReactNode } from "react";

import { AgentIcon } from "@/components/agent-icon";
import { AGENT_DOT } from "@/components/usage-map";
import { Check, ChevronRight, CircleDashed, Layers, TriangleAlert } from "@/components/ui/icon";
import { ListSection } from "@/components/ui/list-group";
import { Segmented } from "@/components/ui/segmented";
import type { UsageAccount, UsageAgent, UsagePeriod, UsageRow, UsageWeek } from "@/lib/types";
import { realAccounts, usd } from "@/lib/usage";
import { AGENT_NAME, monthName, tokens, usdShort, weekName, type LimitBlock, type WindowView } from "@/lib/usage-view";
import { cn } from "@/lib/utils";

// The usage page's cards (routes/usage.tsx): the totals, the plan limits, the weeks, the month's
// breakdown and the account list. Drawn from one answer of GET /api/usage; none of them fetches.

const card = "rounded-xl border bg-card";
const hairline = "relative not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-4 not-first:before:h-px not-first:before:bg-border";

const Mark = ({ agent }: { agent: UsageAgent }) => <span aria-hidden="true" className="contents"><AgentIcon agent={agent} className="size-4" /></span>;
const Dot = ({ agent }: { agent: UsageAgent }) => <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", AGENT_DOT[agent])} />;

// ── Totals ─────────────────────────────────────────────────────────────────────────────────────

export function Stats({ periods, desk }: { periods: UsagePeriod[]; desk: boolean }) {
  const label = (p: UsagePeriod) => (p.key === "today" ? "Today" : p.key === "week" ? "This week" : monthName(p.from));
  const shown = periods.filter((p) => p.key !== "all");
  return (
    <ul aria-label="Totals" className={cn("grid grid-cols-3", desk ? "gap-3" : "gap-2")}>
      {shown.map((p) => (
        <li key={p.key} className={cn(card, "usage-stat")}>
          <span className={cn("text-muted-foreground", desk ? "text-footnote" : "text-caption")}>{label(p)}</span>
          <span className="usage-stat-value tabular-nums">{desk ? usd(p.cost) : usdShort(p.cost)}</span>
          <span className={cn("truncate text-subtle-foreground tabular-nums", desk ? "text-footnote" : "text-caption")}>{tokens(p.tokens)} tokens</span>
          {desk && Object.keys(p.agents).length > 1 && (
            <span className="mt-1 flex gap-2.5 text-caption text-subtle-foreground tabular-nums">
              {(["claude", "codex"] as const).map((a) => <span key={a} className="flex items-center gap-1.5"><Dot agent={a} />{usd(p.agents[a]?.cost ?? 0)}</span>)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Plan limits ────────────────────────────────────────────────────────────────────────────────

/** A window's colour: red from 90 %, amber from 75 %. Whole class names, so Tailwind finds them. */
const tone = (pct: number) => (pct >= 90 ? { text: "text-status-blocked", bar: "bg-status-blocked" } : pct >= 75 ? { text: "text-status-working", bar: "bg-status-working" } : undefined);

function Window({ view }: { view: WindowView }) {
  const t = tone(view.pct);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-footnote">
        <span className="text-muted-foreground">{view.name}</span>
        {view.missing
          ? <span className="text-subtle-foreground">No reading yet</span>
          : <span className={cn("font-semibold tabular-nums", t?.text)}>{view.pct}%</span>}
      </div>
      {view.missing
        ? <div className="usage-pending h-1.5 rounded-full" />
        : (
          <div role="meter" aria-label={view.name} aria-valuenow={view.pct} aria-valuemin={0} aria-valuemax={100} className="usage-meter h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full", t?.bar ?? "bg-primary")} style={{ width: `${Math.max(view.pct, 1.5)}%` }} />
          </div>
        )}
      <div className="text-caption text-pretty text-subtle-foreground tabular-nums">{view.detail}</div>
    </div>
  );
}

export function LimitsCard({ blocks, more, onMore }: {
  blocks: LimitBlock[];
  more: Array<{ agent: UsageAgent; count: number; best?: string }>;
  onMore: () => void;
}) {
  return (
    <ListSection title="Plan limits">
      {!blocks.length && !more.length && <p className="px-4 py-3 text-footnote text-muted-foreground">No plan limit seen yet. Claude Code reports its own after a reply, and Codex with each turn.</p>}
      {blocks.map((b) => (
        <div key={b.key} className={cn(hairline, "flex flex-col gap-3 px-4 py-3.5")}>
          <div className="flex items-center gap-2">
            <Mark agent={b.agent} />
            <span className="min-w-0 truncate text-body font-medium">{b.title}</span>
            {b.active && <span className="flex shrink-0 items-center gap-1 text-caption font-medium text-status-done"><span aria-hidden="true" className="size-1.5 rounded-full bg-status-done" />Active</span>}
            <span className="flex-1" />
            {b.plan && <span className="text-caption text-subtle-foreground">{b.plan}</span>}
          </div>
          <div className={cn("grid gap-4", b.windows.length > 1 && "grid-cols-2")}>
            {b.windows.map((v) => <Window key={v.name} view={v} />)}
          </div>
          {b.alert && (
            <p role="alert" className="usage-alert flex items-start gap-2 rounded-lg px-3 py-2.5 text-footnote">
              <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0 text-status-blocked" />{b.alert}
            </p>
          )}
        </div>
      ))}
      {more.map((m) => (
        <button key={m.agent} type="button" onClick={onMore} className={cn(hairline, "flex min-h-10 items-center gap-2 px-4 text-left coarse:min-h-11 hover:bg-accent last:rounded-b-xl")}>
          <span className="flex-1 text-body">{m.count} more {AGENT_NAME[m.agent]} {m.count === 1 ? "account" : "accounts"}</span>
          {m.best && <span className="text-footnote text-subtle-foreground tabular-nums">{m.best}</span>}
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-subtle-foreground" />
        </button>
      ))}
    </ListSection>
  );
}

// ── By week ────────────────────────────────────────────────────────────────────────────────────

/** A round top for the axis: 10,000 over 9,574. */
function axisTop(max: number): number {
  if (max <= 0) return 1;
  const half = 10 ** Math.floor(Math.log10(max)) / 2;
  return Math.ceil(max / half) * half;
}

export function WeeksCard({ weeks }: { weeks: UsageWeek[] }) {
  const cost = (w: UsageWeek, a: UsageAgent) => w.agents[a]?.cost ?? 0;
  const top = axisTop(Math.max(...weeks.map((w) => cost(w, "claude") + cost(w, "codex"))));
  const h = (v: number) => `${(v / top) * 100}%`;
  return (
    <section aria-label="By week" className={cn(card, "flex flex-col gap-3 p-4")}>
      <div className="flex items-center gap-3">
        <h2 className="flex-1 text-subhead font-semibold">By week</h2>
        <Legend />
      </div>
      <div className="usage-bars">
        {[top / 2, top].map((v) => (
          <span key={v} aria-hidden="true" className="usage-axis" style={{ bottom: h(v) }}>
            <span className="text-micro font-normal text-subtle-foreground tabular-nums">{usdShort(v)}</span>
          </span>
        ))}
        {weeks.map((w, i) => (
          <div key={w.start} role="img" aria-label={`Week of ${weekName(w.start)}: ${usd(cost(w, "claude") + cost(w, "codex"))}`}>
            {cost(w, "codex") > 0 && <span className="usage-codex" style={{ height: h(cost(w, "codex")) }} />}
            {cost(w, "claude") > 0 && <span className={i === weeks.length - 1 ? "usage-week-now" : "usage-claude"} style={{ height: h(cost(w, "claude")) }} />}
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="usage-weeks text-micro font-normal text-subtle-foreground">
        {weeks.map((w, i) => <span key={w.start}>{(weeks.length - 1 - i) % 2 ? "" : weekName(w.start)}</span>)}
      </div>
    </section>
  );
}

const Legend = () => (
  <span className="flex gap-3 text-caption text-muted-foreground">
    {(["claude", "codex"] as const).map((a) => <span key={a} className="flex items-center gap-1.5"><Dot agent={a} />{AGENT_NAME[a]}</span>)}
  </span>
);

// ── The month by agent, model or project ───────────────────────────────────────────────────────

type By = "agent" | "model" | "project";
const BY = [{ value: "agent", label: "Agent" }, { value: "model", label: "Model" }, { value: "project", label: "Project" }] as const;

export function BreakdownCard({ month }: { month: UsagePeriod }) {
  const [by, setBy] = useState<By>("model");
  const title = `${monthName(month.from)} by`;
  const rows: UsageRow[] = by === "model" ? month.byModel : by === "project" ? month.byProject
    : (["claude", "codex"] as const).flatMap((a) => (month.agents[a] ? [{ id: a, label: AGENT_NAME[a], agent: a, ...month.agents[a] }] : []));
  const max = Math.max(...rows.map((r) => r.cost), 0.01);
  return (
    <section aria-label={title} className={cn(card, "flex flex-col gap-2 px-4 pt-4 pb-2")}>
      <div className="flex items-center gap-3">
        <h2 className="flex-1 text-subhead font-semibold">{title}</h2>
        <Segmented label="Group by" className="usage-seg" options={BY} value={by} onChange={setBy} />
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-1.5 py-2">
            <div className="flex items-center gap-2 text-subhead tabular-nums">
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <span className="text-caption text-subtle-foreground">{tokens(r.tokens)}</span>
              <span className="usage-amount font-medium">{usd(r.cost)}</span>
            </div>
            <div className="h-1 rounded-full bg-muted">
              <div className={cn("h-full rounded-full", AGENT_DOT[r.agent])} style={{ width: `${Math.max(0.8, (r.cost / max) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Accounts ───────────────────────────────────────────────────────────────────────────────────

export function AccountList({ accounts, selected, onSelect, check }: {
  accounts: UsageAccount[];
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  /** A desk marks the account picked; a sheet closes on the tap instead. */
  check: boolean;
}) {
  const total = accounts.reduce((sum, a) => sum + a.month.cost, 0);
  const row = (id: string | undefined, lead: ReactNode, name: ReactNode, sub: string | undefined, cost: number) => (
    <button
      key={id ?? "all"}
      type="button"
      role="option"
      aria-selected={selected === id}
      onClick={() => onSelect(id)}
      className={cn("usage-account relative flex min-h-12 w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-accent first:rounded-t-xl last:rounded-b-xl", selected === id && "usage-selected")}
    >
      {lead}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 text-body">{name}</span>
        {sub && <span className="text-caption text-pretty text-subtle-foreground tabular-nums">{sub}</span>}
      </span>
      <span className="text-subhead font-medium tabular-nums">{usd(cost)}</span>
      {check && selected === id && <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />}
    </button>
  );
  const unassigned = accounts.find((a) => a.source === "none");
  return (
    <div role="listbox" aria-label="Account" className={cn(card, "flex flex-col")}>
      {row(undefined, <Layers aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />, "All accounts", undefined, total)}
      {realAccounts(accounts).map((a) => row(
        a.id, <Mark agent={a.agent} />,
        <>{a.label}{a.active && <span aria-hidden="true" className="size-1.5 rounded-full bg-status-done" />}</>,
        `${AGENT_NAME[a.agent]} · ${tokens(a.month.tokens)} tokens`, a.month.cost,
      ))}
      {unassigned && row(unassigned.id, <CircleDashed aria-hidden="true" className="size-4 shrink-0 text-subtle-foreground" />, "Unassigned", `${AGENT_NAME[unassigned.agent]} with no account on record`, unassigned.month.cost)}
    </div>
  );
}
