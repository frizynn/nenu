import type { PullRequestView } from "@/lib/types";

type Checks = NonNullable<PullRequestView["checks"]>;

/** The chip's words: passed out of total, or plain CI while nothing was counted yet. */
export function ciLabel(checks: Checks | undefined): string {
  if (!checks) return "CI";
  const total = checks.passed + checks.failed + checks.pending;
  return total ? `CI ${checks.passed}/${total}` : "CI";
}

export function ciTone(checks: Checks | undefined): string {
  if (!checks) return "bg-muted-foreground/50";
  if (checks.failed) return "bg-status-blocked";
  return checks.pending ? "bg-status-working" : "bg-status-done";
}
