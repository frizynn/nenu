import { isAbsolute } from "node:path";

import { parseDecisions } from "./org-asks.ts";
import type { StatusFile, TokenUsage } from "./org-types.ts";
import { THREAD_VERDICTS, type PlainSummary, type ThreadCapture, type ThreadDeliverable, type ThreadVerdict } from "./types.ts";

// What `overview --json` says of a thread's last report, and of a coordinator's STATUS.md, read
// within the bounds Organizations writes them (docs/json.md). Every field is newer than the rest of
// the contract: an Organizations that predates one, or a malformed value, reads as none, and a
// longer list is cut, never refused.

/**
 * A coordinator's STATUS.md as Organizations prints it. Organizations names the field `status_file`,
 * since `status` is already the project's and the thread's lifecycle.
 */
export interface OrgStatusFile extends StatusFile {
  path: string;
}

export interface OrgReport {
  /** The report's `Status:` line. */
  verdict: ThreadVerdict | null;
  summary: string | null;
  /** The summary agent's plain summary of the report; null before one was asked for. */
  plain_summary: PlainSummary | null;
  captures: ThreadCapture[];
  deliverables: ThreadDeliverable[];
  /** A coordinator's STATUS.md; null for a worker and without one. */
  status_file: OrgStatusFile | null;
  /** The home copy of its report, in the project's records folder; null before there is one, or from an Organizations that predates it. */
  report: string | null;
  /** The folder for the files it produced, `<records>/library/<id>`; empty from an Organizations that predates it. */
  library: string;
}

const MAX_SUMMARY_CHARS = 600;
const MAX_PLAIN_CHARS = 900;
const MAX_CAPTURES = 24;
const MAX_DELIVERABLES = 10;
const MAX_STATUS_CHARS = 8_000;
const DELIVERABLE_KINDS: ReadonlyArray<ThreadDeliverable["kind"]> = ["html", "pdf"];

/** A thread's report fields, out of the thread's own record. */
export function parseReport(thread: Record<string, unknown>): OrgReport {
  return {
    verdict: THREAD_VERDICTS.find((verdict) => verdict === thread.verdict) ?? null,
    summary: typeof thread.summary === "string" && thread.summary.trim() ? thread.summary.slice(0, MAX_SUMMARY_CHARS) : null,
    plain_summary: parsePlainSummary(thread.plain_summary),
    captures: libraryFiles(thread.captures, MAX_CAPTURES, (item) => ({ caption: typeof item.caption === "string" ? item.caption : "" })),
    deliverables: libraryFiles(thread.deliverables, MAX_DELIVERABLES, (item) => {
      const kind = DELIVERABLE_KINDS.find((candidate) => candidate === item.kind);
      return kind && { kind };
    }),
    status_file: parseStatusFile(thread.status_file),
    report: absolutePath(thread.report) ? thread.report : null,
    library: absolutePath(thread.library) ? thread.library : "",
  };
}

/**
 * A STATUS.md with an absolute path and some text; anything else reads as none. What Organizations
 * reads out of the text (its objective and decisions) comes only when it printed them.
 */
export function parseStatusFile(value: unknown): OrgStatusFile | null {
  if (!isRecord(value) || !absolutePath(value.path) || typeof value.text !== "string" || !value.text.trim()) return null;
  const updated = typeof value.updated === "string" && Number.isFinite(Date.parse(value.updated)) ? value.updated : "";
  const objective = typeof value.objective === "string" ? value.objective.trim().slice(0, MAX_SUMMARY_CHARS) : "";
  const needsDecision = parseDecisions(value.needs_decision);
  return {
    path: value.path, text: value.text.slice(0, MAX_STATUS_CHARS), updated,
    ...(objective ? { objective } : {}),
    ...(needsDecision.length ? { needsDecision } : {}),
  };
}

/** A plain summary with text or an error; anything else reads as none. */
export function parsePlainSummary(value: unknown): PlainSummary | null {
  if (!isRecord(value) || typeof value.text !== "string" || typeof value.current !== "boolean") return null;
  const text = value.text.trim().slice(0, MAX_PLAIN_CHARS);
  const error = typeof value.error === "string" ? value.error.trim().slice(0, MAX_SUMMARY_CHARS) : "";
  if (!text && !error) return null;
  return { text, current: value.current, ...(error ? { error } : {}) };
}

/** Token use as Organizations last read it; null before a read, or when any count is not one. */
export function parseUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const read = (key: string) => isCount(value[key]) ? value[key] : -1;
  const counts = {
    input: read("input"), output: read("output"), cacheRead: read("cache_read"), cacheWrite: read("cache_write"),
    context: read("context"), peakContext: read("peak_context"), compactions: read("compactions"),
  };
  if (Object.values(counts).some((count) => count < 0)) return null;
  const overCap = Array.isArray(value.over_cap) ? value.over_cap.filter((cap): cap is string => typeof cap === "string" && /^[a-z][a-z_]{0,39}$/.test(cap)) : [];
  const updated = typeof value.updated === "string" && Number.isFinite(Date.parse(value.updated)) ? value.updated : "";
  return { ...counts, updated, overCap };
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The files of a report's list that name an absolute path, each with the rest `extra` reads; a malformed entry is skipped. */
function libraryFiles<T extends object>(value: unknown, max: number, extra: (item: Record<string, unknown>) => T | undefined): Array<{ path: string } & T> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || !absolutePath(item.path)) return [];
    const rest = extra(item);
    return rest ? [{ path: item.path, ...rest }] : [];
  }).slice(0, max);
}

const absolutePath = (value: unknown): value is string =>
  typeof value === "string" && isAbsolute(value) && value.length <= 4096 && !/[\x00-\x1f]/.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
