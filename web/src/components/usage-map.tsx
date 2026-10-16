import { memo, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { Info } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import type { UsageAccount } from "@/lib/types";
import { usd } from "@/lib/usage";
import { AGENT_DOT, dayName, tokens, WEEKS, type MapCell, type MapModel } from "@/lib/usage-view";
import { cn } from "@/lib/utils";

type Metric = "cost" | "tokens";
const METRICS = [{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }] as const;
const STEP: Partial<Record<string, number>> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };

/**
 * The activity map: a day per square, cost by default and tokens a tap away. The squares are drawn
 * once per answer and once per metric; the pointer and the arrow keys move one active square (a ring
 * on its grid area) and the day's detail, through one listener on the grid, so no square redraws.
 * A phone shows the day under the map; a desk shows it beside the square while pointed at or focused.
 */
export function ActivityCard({ model, accounts, title = "Activity" }: { model: MapModel; accounts: UsageAccount[]; title?: string }) {
  const id = useId();
  const [metric, setMetric] = useState<Metric>("cost");
  const [active, setActive] = useState(model.today);
  const [shown, setShown] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const cell = model.cells[active];

  // A phone opens on the latest weeks.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  function point(event: PointerEvent) {
    const i = Number((event.target as HTMLElement).dataset.i);
    if (Number.isInteger(i)) setActive(i);
    setShown(true);
  }

  function key(event: KeyboardEvent) {
    const step = STEP[event.key];
    const next = step !== undefined ? active + step : event.key === "Home" ? 0 : event.key === "End" ? model.today : undefined;
    if (next === undefined) return;
    event.preventDefault();
    // A step past either end of the year, or into the days after today, stays where it is.
    if (next < 0 || next > model.today) return;
    setActive(next);
    document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  const col = Math.floor(active / 7);
  return (
    <section aria-label={title} className="usage-map relative flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3">
        <h2 className="min-w-0 flex-1 truncate text-subhead font-semibold">{title}</h2>
        <Segmented label="Measure" className="usage-seg" options={METRICS} value={metric} onChange={setMetric} />
      </div>
      <div ref={scroller} className="usage-scroll">
        <div className="usage-frame text-micro font-normal text-subtle-foreground">
          <span className="usage-corner" />
          <div aria-hidden="true" className="usage-months">
            {model.months.map((m) => <span key={m.col} style={{ gridColumnStart: m.col + 1 }}>{m.label}</span>)}
          </div>
          <div aria-hidden="true" className="usage-days">
            <span /><span>Tue</span><span /><span>Thu</span><span /><span>Sat</span>
          </div>
          <div
            role="listbox"
            tabIndex={0}
            aria-label={`${title}, a square per day`}
            aria-activedescendant={`${id}-${active}`}
            className="usage-grid"
            onPointerOver={point}
            onPointerLeave={() => setShown(false)}
            onFocus={() => setShown(true)}
            onBlur={() => setShown(false)}
            onKeyDown={key}
          >
            <Squares cells={model.cells} metric={metric} id={id} />
            {/* Both ends named: an absolute grid child's open end runs to the grid's edge. */}
            <span aria-hidden="true" className="usage-ring" style={{ gridColumn: `${col + 1} / span 1`, gridRow: `${(active % 7) + 1} / span 1` }} />
          </div>
        </div>
      </div>
      {cell && <DayDetail cell={cell} busiest={cell.date === model.busiest} accounts={accounts} shown={shown} col={col} />}
      <div className="flex items-center justify-between gap-3 text-caption text-subtle-foreground">
        <span className="tabular-nums">{model.activeDays} active {model.activeDays === 1 ? "day" : "days"}{model.since && ` · since ${model.since}`}</span>
        <span aria-hidden="true" className="usage-legend flex items-center gap-1">
          Less{[0, 1, 2, 3, 4].map((l) => <span key={l} style={{ background: `var(--heat-${l})` }} />)}More
        </span>
      </div>
      {model.striped && (
        <p className="flex items-start gap-2 text-footnote text-muted-foreground">
          <Info aria-hidden="true" className="mt-px size-4 shrink-0 text-subtle-foreground" />
          Claude Code deletes transcripts after 30 days, so striped days have no logs left. From now on Nenu keeps a daily total.
        </p>
      )}
    </section>
  );
}

/** The 371 squares. Memoised on the answer and the metric alone: nothing the pointer does reaches it. */
const Squares = memo(function Squares({ cells, metric, id }: { cells: Array<MapCell | null>; metric: Metric; id: string }) {
  const by = metric === "cost" ? 0 : 1;
  return cells.map((c, i) => c
    ? <span key={i} id={`${id}-${i}`} data-i={i} role="option" aria-selected="false" aria-label={c.label} className={c.striped ? "s" : `l${c.levels[by]}`} />
    : <span key={i} aria-hidden="true" />);
});

/** The active day: a bar under the map on a phone, a card beside the square on a desk. */
function DayDetail({ cell, busiest, accounts, shown, col }: { cell: MapCell; busiest: boolean; accounts: UsageAccount[]; shown: boolean; col: number }) {
  const day = cell.day;
  const label = new Map(accounts.map((a) => [a.id, a]));
  const split = (day?.accounts ?? []).filter((a) => a.cost >= 0.005).sort((a, b) => b.cost - a.cost).slice(0, 4);
  // Beside the square, on the side with room; 2.25rem clears the weekday labels and a gap.
  const side = col >= WEEKS / 2 ? { right: `calc(${WEEKS - col} * (var(--cell) + var(--gap)) + 0.75rem)` } : { left: `calc(${col + 1} * (var(--cell) + var(--gap)) + 2.25rem)` };
  return (
    <div role="group" aria-label="Day detail" data-shown={shown || undefined} style={side}
      className="usage-detail flex flex-col gap-1.5 rounded-lg bg-muted px-2.5 py-2 text-footnote tabular-nums">
      <div className="flex items-baseline justify-between gap-3">
        <span>
          <b className="font-semibold">{dayName(cell.date)}</b>
          {day && <span className="text-subtle-foreground lg:hidden"> · {tokens(day.tokens)}</span>}
        </span>
        <b className="font-semibold">{cell.striped ? "No logs" : usd(day?.cost ?? 0)}</b>
      </div>
      {day && <div className="hidden text-caption text-subtle-foreground lg:block">{tokens(day.tokens)} tokens{busiest && " · busiest day"}</div>}
      {split.length > 0 && (
        <div className="hidden lg:block">
          {split.map((a) => (
            <div key={a.id} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={cn("size-1.5 rounded-full", AGENT_DOT[a.id.startsWith("codex") ? "codex" : "claude"])} />
              <span className="flex-1 text-muted-foreground">{label.get(a.id)?.label ?? "Unassigned"}</span>
              {usd(a.cost)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
