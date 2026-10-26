import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Check, GitPullRequest, ListFilter, Search, X } from "@/components/ui/icon";

import { DiffStat } from "@/components/diff-stat";
import { FoldedList, isOpening, OpeningSpinner } from "@/components/home-panels";
import { QuietMenu, quietMenuItem } from "@/components/ui/quiet-menu";
import { ACTIVITY_POLL_MS, activityConcerns } from "@/hooks/use-activity";
import { fetchActivity, type ActivityResponse } from "@/lib/activity";
import { useEnter } from "@/lib/enter";
import { PR_STATES, prState, readyToMerge, reviewsByRepo, type RepoReviews, type ReviewEntry } from "@/lib/home-stats";
import { isLocked, useLocked } from "@/lib/idle";
import { isLiveHealthy, onLiveEvent } from "@/lib/live-events";
import { panePath } from "@/lib/nav";
import { filterReviews, SCOPE_LABEL, STATE_LABEL, usePrFilter, type PrFilter } from "@/lib/pr-filter";
import { cn, keepUnchanged } from "@/lib/utils";
import type { AgentView } from "@/lib/types";

/** How many Claude panes Home reads background work for, most recently active first. */
export const HOME_ACTIVITY_PANES = 8;

/**
 * Background work of the most recently active Claude panes, by pane. One read per pane, refreshed
 * when the stream names that pane and on the activity view's fallback poll; paused behind the idle
 * cover and while the page is hidden (ADR 0054).
 */
export function useHomeActivity(agents: readonly AgentView[], session?: string): ReadonlyMap<string, ActivityResponse> {
  const locked = useLocked();
  const [byPane, setByPane] = useState<ReadonlyMap<string, ActivityResponse>>(new Map());
  const ids = agents
    .filter((agent) => agent.agent === "claude" && agent.hasSession)
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
    .slice(0, HOME_ACTIVITY_PANES)
    .map((agent) => agent.paneId)
    .sort();
  const key = ids.join("\0");

  useEffect(() => {
    if (locked || !key) return void setByPane(new Map());
    const panes = key.split("\0");
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function read(paneId: string) {
      if (disposed || document.hidden || isLocked()) return;
      try {
        const res = await fetchActivity(paneId, session, controller.signal);
        if (!disposed) setByPane((prev) => {
          const kept = keepUnchanged(prev.get(paneId), res);
          return kept === prev.get(paneId) ? prev : new Map(prev).set(paneId, kept);
        });
      } catch {
        // A failed read keeps what was last known; the next poll tries again.
      }
    }
    function pollAll() {
      clearTimeout(timer);
      void Promise.all(panes.map(read)).finally(() => {
        if (!disposed) timer = setTimeout(pollAll, isLiveHealthy() ? ACTIVITY_POLL_MS.live : ACTIVITY_POLL_MS.quiet);
      });
    }
    const visibility = () => { if (!document.hidden) pollAll(); };
    const stopLive = onLiveEvent((event) => {
      if (event.topic === "resync") return pollAll();
      for (const paneId of panes) if (activityConcerns(event, paneId)) void read(paneId);
    });
    setByPane((prev) => new Map([...prev].filter(([paneId]) => panes.includes(paneId))));
    document.addEventListener("visibilitychange", visibility);
    pollAll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
      stopLive();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [key, session, locked]);

  return byPane;
}

/**
 * What a pull request's checks say, in two or three words, and their colour; null when it has none. The
 * colour is a phone's: a desk keeps the words grey and the colour to the row's icon.
 */
function checksWord(checks: ReviewEntry["checks"]): { word: string; tone: string } | null {
  if (!checks) return null;
  if (checks.failed) return { word: `${checks.failed} ${checks.failed === 1 ? "check" : "checks"} failing`, tone: "max-lg:text-destructive" };
  if (checks.pending) return { word: "checks running", tone: "max-lg:text-status-working" };
  return checks.passed ? { word: "checks passed", tone: "max-lg:text-status-done" } : null;
}

const REVIEW_WORDS: Record<NonNullable<ReviewEntry["review"]>, { word: string; tone?: string }> = {
  approved: { word: "approved", tone: "max-lg:text-status-done" },
  changes_requested: { word: "changes requested", tone: "max-lg:text-destructive" },
  review_required: { word: "needs review" },
};

const rowClass = "relative grid min-h-13 min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-1 py-2 hover:bg-[var(--workbench-row-hover)] sm:min-h-12 sm:rounded-lg sm:px-2.5";

/**
 * A pull request as one row and one tap: its title, then its number and what its checks and review
 * say in a few words, its size at the end; its repo is the heading it sits under. The tap opens the
 * chat on its branch in Nenu, else its page on GitHub.
 */
function ReviewRow({ entry, session, opening }: { entry: ReviewEntry; session?: string; opening: string | null }) {
  const checks = checksWord(entry.checks);
  const review = entry.review && REVIEW_WORDS[entry.review];
  const number = entry.number !== undefined && { word: `#${entry.number}`, tone: "font-mono" };
  const said = [checks, review, entry.draft && { word: "draft" }].filter((fact): fact is { word: string; tone?: string } => !!fact);
  const facts = number ? [number, ...said] : said;
  const size = entry.diff && `+${entry.diff.additions} −${entry.diff.deletions}`;
  const label = [entry.title, number && number.word, size, ...said.map((fact) => fact.word)].filter(Boolean).join(", ");
  const to = entry.open && panePath(entry.open.paneId, session);
  const busy = !!to && isOpening(opening, to);
  const enter = useEnter();
  // What a desk says in red, on the icon alone: a check failing or changes asked for.
  const blocked = !!entry.checks?.failed || entry.review === "changes_requested";
  const body = <>
    <GitPullRequest aria-hidden className={cn("row-span-2 size-4 shrink-0 justify-self-center",
      readyToMerge(entry) ? "text-status-done" : blocked ? "text-muted-foreground lg:text-destructive" : "text-muted-foreground")} />
    <span className="col-start-2 truncate text-subhead">{entry.title}</span>
    <span className="col-start-2 row-start-2 flex min-w-0 items-baseline gap-1 truncate text-footnote text-muted-foreground">
      {facts.map((fact, index) => <span key={fact.word} className={cn("shrink-0", fact.tone)}>{index > 0 && <span aria-hidden className="text-muted-foreground">· </span>}{fact.word}</span>)}
    </span>
    <span className="col-start-3 row-span-2 row-start-1 flex items-center gap-3 text-footnote text-muted-foreground">
      {entry.diff && <DiffStat diff={entry.diff} className="text-caption" />}
      {busy && <OpeningSpinner />}
    </span>
  </>;
  return (
    <li className={enter}>
      {to ? <Link to={to} aria-label={label} aria-busy={busy || undefined} className={cn(rowClass, busy && "bg-[var(--workbench-row-hover)]")}>{body}</Link>
        : entry.url ? <a href={entry.url} target="_blank" rel="noopener noreferrer" aria-label={label} className={rowClass}>{body}</a>
        : <div aria-label={label} className={rowClass}>{body}</div>}
    </li>
  );
}

/** How many of a repo's PRs show before "Show N more": its first run, the ones that need a hand. */
export const REPO_ROWS = 3;

/** One repo's run: its owner unless it is `home`, its name and how many, then its PRs, the rest folded. */
function RepoRun({ repo, home, session, opening }: { repo: RepoReviews; home?: string; session?: string; opening: string | null }) {
  const id = useId();
  const owner = repo.owner && repo.owner !== home ? repo.owner : undefined;
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <h3 id={id} className="flex min-w-0 items-baseline px-1 pb-1 pt-6 text-footnote sm:px-2.5">
        {owner && <span className="min-w-0 truncate text-muted-foreground">{owner}/</span>}
        <span className="truncate font-semibold text-foreground">{repo.name}</span>
        <span className="ml-auto shrink-0 pl-3 tabular-nums text-muted-foreground"><span className="sr-only">, </span>{repo.entries.length}<span className="sr-only"> open</span></span>
      </h3>
      <FoldedList items={repo.entries} rows={REPO_ROWS} name={owner ? `${owner}/${repo.name}` : repo.name}>
        {(entry) => <ReviewRow key={entry.key} entry={entry} session={session} opening={opening} />}
      </FoldedList>
    </section>
  );
}

/** The owner most repos belong to, the person's own account most of the time: the one a heading leaves out. */
function homeOwner(repos: readonly RepoReviews[]): string | undefined {
  const owners = new Map<string, number>();
  for (const repo of repos) if (repo.owner) owners.set(repo.owner, (owners.get(repo.owner) ?? 0) + 1);
  return [...owners].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const menuGroupLabel = "px-2.5 pb-1 pt-2 text-caption font-medium text-muted-foreground";
const menuCount = "shrink-0 text-footnote tabular-nums text-muted-foreground";
const textAction = "-mx-2 inline-flex min-h-9 items-center px-2 font-medium text-muted-foreground hover:text-foreground coarse:min-h-11";

/**
 * What the PRs tab lists, in one menu: the repos in use or all of them, then which states and which
 * repos, each with how many it holds. Several can be ticked, so a row keeps the menu open; Clear
 * filters closes it, as the row it is on goes away.
 */
function PrFilterMenu({ entries, filter, set, home }: {
  entries: readonly ReviewEntry[];
  filter: PrFilter;
  set: (next: PrFilter) => void;
  home?: string;
}) {
  const { scoped, repos: narrowing } = filterReviews(entries, filter);
  const filters = narrowing.length + filter.states.length;
  const inScope = reviewsByRepo(scoped);
  const toggle = <T,>(list: readonly T[], item: T) => list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
  const label = SCOPE_LABEL[filter.scope];
  const row = (checked: boolean, words: ReactNode, count: number) => <>
    <Check aria-hidden className={cn("size-4 shrink-0 text-foreground", !checked && "invisible")} />
    <span className="min-w-0 flex-1 truncate">{words}</span>
    <span className={menuCount}>{count}</span>
  </>;
  return (
    <QuietMenu icon={ListFilter} align="end" menuLabel="Filter pull requests" className="-mr-1 ml-auto sm:-mr-2"
      label={<>{label}{filters > 0 && <span className="tabular-nums"> · {filters}</span>}</>}
      ariaLabel={`Filter: ${label}${filters ? `, ${plural(filters, "more filter")}` : ""}`}
      menuClassName="w-64 max-h-[min(30rem,calc(100dvh-12rem))] overflow-y-auto overscroll-contain">
      {(close) => <>
        <div role="group" aria-label="Show">
          <p aria-hidden className={menuGroupLabel}>Show</p>
          {(["inUse", "all"] as const).map((scope) => (
            <button key={scope} type="button" role="menuitemradio" aria-checked={filter.scope === scope}
              onClick={() => set({ ...filter, scope })} className={quietMenuItem}>
              {row(filter.scope === scope, SCOPE_LABEL[scope], filterReviews(entries, { ...filter, scope }).scoped.length)}
            </button>
          ))}
        </div>
        <div role="separator" className="-mx-1 my-1 h-px bg-border" />
        <div role="group" aria-label="State">
          <p aria-hidden className={menuGroupLabel}>State</p>
          {PR_STATES.map((state) => (
            <button key={state} type="button" role="menuitemcheckbox" aria-checked={filter.states.includes(state)}
              onClick={() => set({ ...filter, states: toggle(filter.states, state) })} className={quietMenuItem}>
              {row(filter.states.includes(state), STATE_LABEL[state], scoped.filter((entry) => prState(entry) === state).length)}
            </button>
          ))}
        </div>
        {inScope.length > 1 && <>
          <div role="separator" className="-mx-1 my-1 h-px bg-border" />
          <div role="group" aria-label="Repos">
            <p aria-hidden className={menuGroupLabel}>Repos</p>
            {inScope.map((repo) => (
              <button key={repo.key} type="button" role="menuitemcheckbox" aria-checked={filter.repos.includes(repo.key)}
                onClick={() => set({ ...filter, repos: toggle(filter.repos, repo.key) })} className={quietMenuItem}>
                {row(filter.repos.includes(repo.key), <>{repo.owner && repo.owner !== home && <span className="text-muted-foreground">{repo.owner}/</span>}{repo.name}</>, repo.entries.length)}
              </button>
            ))}
          </div>
        </>}
        {/* Also while every repo is ticked: those ticks narrow nothing now, and would once another repo comes. */}
        {(filter.repos.length > 0 || filter.states.length > 0) && <>
          <div role="separator" className="-mx-1 my-1 h-px bg-border" />
          <button type="button" role="menuitem" onClick={() => { set({ ...filter, repos: [], states: [] }); close(); }} className={quietMenuItem}>
            <X aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Clear filters</span>
          </button>
        </>}
      </>}
    </QuietMenu>
  );
}

/**
 * Home's PRs tab: the open pull requests of the repos the herd is using, or all of them, under their
 * repo, narrowed on this device by state, repo or a search (ADR 0128). The owner of most of the repos
 * is the person's own account, so only the others name theirs. What the filter holds back is said: how
 * many of how many it shows, and how many more All would add from repos no pane is in.
 */
export function PullRequestList({ entries, session, opening }: { entries: readonly ReviewEntry[]; session?: string; opening: string | null }) {
  const { filter, set } = usePrFilter();
  const [query, setQuery] = useState("");
  const { scoped, shown, repos: narrowing } = filterReviews(entries, filter, query);
  const home = homeOwner(reviewsByRepo(entries));
  const repos = reviewsByRepo(shown);
  const narrowed = narrowing.length > 0 || filter.states.length > 0 || query.trim() !== "";
  // What All would add: the rows it would show that are not in use.
  const elsewhere = filter.scope === "inUse" ? filterReviews(entries, { ...filter, scope: "all" }, query).shown.filter((entry) => !entry.inUse).length : 0;
  const clear = () => { setQuery(""); set({ ...filter, repos: [], states: [] }); };
  const showAll = () => set({ ...filter, scope: "all" });
  return (
    <div className="flex flex-col">
      <div className="flex min-h-11 items-center gap-2 px-1 pb-2 sm:min-h-9 sm:px-2.5">
        <div className="flex h-9 min-w-0 flex-1 items-center rounded-lg bg-muted text-muted-foreground focus-within:ring-2 focus-within:ring-ring coarse:h-11 sm:max-w-72">
          <label className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5">
            <Search aria-hidden className="size-4 shrink-0" />
            <input type="text" role="searchbox" enterKeyHint="search" autoComplete="off" spellCheck={false} value={query} placeholder="Search PRs" aria-label="Search pull requests by title or number"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }}
              className="h-full min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground" />
          </label>
          {query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg hover:text-foreground coarse:size-11">
            <X aria-hidden className="size-3.5" />
          </button>}
        </div>
        <PrFilterMenu entries={entries} filter={filter} set={set} home={home} />
      </div>
      <p role="status" className={cn("flex min-h-9 items-center gap-1.5 px-1 text-footnote tabular-nums text-muted-foreground sm:px-2.5", !narrowed && "sr-only")}>
        {narrowed && <>
          <span>{shown.length} of {plural(scoped.length, "PR")}</span>
          <span aria-hidden>·</span>
          <button type="button" onClick={clear} className={textAction}>Clear</button>
        </>}
      </p>
      {shown.length > 0
        ? <div className="flex flex-col [&>section:first-child>h3]:pt-1">
          {repos.map((repo) => <RepoRun key={repo.key} repo={repo} home={home} session={session} opening={opening} />)}
        </div>
        : <p className="flex flex-wrap items-center gap-x-1.5 px-1 py-3 text-footnote text-muted-foreground sm:px-2.5">
          {scoped.length
            ? <>No PR matches.<button type="button" onClick={clear} className={textAction}>Clear filters</button></>
            : <>No open PRs in the repos your panes are in.<button type="button" onClick={showAll} className={textAction}>Show all {entries.length}</button></>}
        </p>}
      {elsewhere > 0 && scoped.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-x-1.5 border-t border-border px-1 pt-1 text-footnote text-muted-foreground sm:px-2.5">
          {elsewhere} more in repos no pane is in
          <span aria-hidden>·</span>
          <button type="button" onClick={showAll} className={textAction}>Show all</button>
        </p>
      )}
    </div>
  );
}
