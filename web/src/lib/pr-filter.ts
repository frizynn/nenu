// Which of the person's open pull requests Home's PRs tab lists on this device (ADR 0128): those of
// the repos the herd is using (the default) or all of them, narrowed to some repos and some states.
// Kept in localStorage like the workspace order; a store that throws keeps it for the page's life. The
// search box narrows too, but it is a moment's question and is never kept.
import { useSyncExternalStore } from "react";

import { PR_STATES, prState, type PrState, type ReviewEntry } from "./home-stats";

export type PrScope = "inUse" | "all";

export interface PrFilter {
  scope: PrScope;
  /** Repos by `repoKey`; none narrows nothing. */
  repos: readonly string[];
  /** None narrows nothing. */
  states: readonly PrState[];
}

export const DEFAULT_PR_FILTER: PrFilter = { scope: "inUse", repos: [], states: [] };

export const SCOPE_LABEL: Record<PrScope, string> = { inUse: "In use", all: "All" };

export const STATE_LABEL: Record<PrState, string> = { ready: "Ready to merge", attention: "Needs attention", review: "In review", draft: "Draft" };

/** A pull request's repo, as the PRs tab groups it: `owner/name`, or the name when no URL names the owner. */
export const repoKey = (entry: Pick<ReviewEntry, "owner" | "repo">) => entry.owner ? `${entry.owner}/${entry.repo}` : entry.repo;

const KEY = "nenu:pr-filter:v1";
let parsed: { raw: string | null; filter: PrFilter } | null = null;
let memory: PrFilter | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null): PrFilter {
  try {
    const stored = JSON.parse(raw ?? "null") as { scope?: unknown; repos?: unknown; states?: unknown } | null;
    if (!stored || typeof stored !== "object") return DEFAULT_PR_FILTER;
    return {
      scope: stored.scope === "all" ? "all" : "inUse",
      repos: Array.isArray(stored.repos) ? stored.repos.filter((repo): repo is string => typeof repo === "string") : [],
      states: Array.isArray(stored.states) ? PR_STATES.filter((state) => (stored.states as unknown[]).includes(state)) : [],
    };
  } catch {
    return DEFAULT_PR_FILTER;
  }
}

function read(): PrFilter {
  if (memory) return memory;
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return DEFAULT_PR_FILTER;
  }
  if (parsed?.raw !== raw) parsed = { raw, filter: parse(raw) };
  return parsed.filter;
}

function write(filter: PrFilter): void {
  try {
    if (filter.scope === "inUse" && !filter.repos.length && !filter.states.length) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(filter));
    memory = null;
  } catch {
    memory = filter;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The filter chosen on this device, and how to change it; Home's headline and its PRs tab both follow. */
export function usePrFilter(): { filter: PrFilter; set: (next: PrFilter) => void } {
  return { filter: useSyncExternalStore(subscribe, read), set: write };
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Whether `entry` answers `query`: every word in its title, or its number (`#12` or `12`). */
export function matchesQuery(entry: ReviewEntry, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const number = /^#?(\d+)$/.exec(words.join(""))?.[1];
  if (number !== undefined && entry.number !== undefined && String(entry.number).startsWith(number)) return true;
  const title = fold(entry.title);
  return words.every((word) => title.includes(word));
}

/** What the PRs tab lists, in steps, so it can say what each one held back. */
export interface FilteredReviews {
  /** In the scope chosen. */
  scoped: ReviewEntry[];
  /** Those of `scoped` the chosen repos and states keep. */
  kept: ReviewEntry[];
  /** Those of `kept` the search answers: the rows on screen. */
  shown: ReviewEntry[];
  /** The chosen repos that have a PR in the scope; one with none there narrows nothing. */
  repos: string[];
}

/**
 * The PRs tab's rows for `filter` and `query`. A repo chosen once that has no PR in the scope now is
 * left out of the narrowing rather than emptying the list; it narrows again when it has one.
 */
export function filterReviews(entries: readonly ReviewEntry[], filter: PrFilter, query = ""): FilteredReviews {
  const scoped = filter.scope === "all" ? [...entries] : entries.filter((entry) => entry.inUse);
  const present = new Set(scoped.map(repoKey));
  const repos = filter.repos.filter((repo) => present.has(repo));
  const kept = scoped.filter((entry) => (!repos.length || repos.includes(repoKey(entry)))
    && (!filter.states.length || filter.states.includes(prState(entry))));
  return { scoped, kept, shown: kept.filter((entry) => matchesQuery(entry, query)), repos };
}
