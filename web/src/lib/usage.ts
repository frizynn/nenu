import type { UsageAccount, UsageOn } from "./types";

// What Settings → Usage says in its own rows. The page's helpers live with the page (usage-view.ts),
// so they load with it and never with Settings.

/** Dollars as the view writes them: cents under $10, whole dollars above. A list price, never a bill. */
export function usd(n: number): string {
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Real accounts only: Unassigned is where usage with no account on record goes. */
export const realAccounts = (accounts: UsageAccount[]) => accounts.filter((a) => a.source !== "none");

/** The Settings row's line: this week's cost and the 5-hour limit of the Claude Code account in use. */
export function usageLine(data: UsageOn): string {
  if (data.scan.firstPass) return "Reading logs…";
  const week = data.periods.find((p) => p.key === "week");
  const inUse = (id?: string) => !id || data.accounts.some((a) => a.active && a.id === id);
  const fiveHour = data.limits.find((l) => l.agent === "claude" && inUse(l.account))?.windows.find((w) => w.name === "five_hour");
  return [week && `${usd(week.cost)} this week`, fiveHour && `5h ${Math.round(fiveHour.usedPercent)}%`].filter(Boolean).join(" · ");
}

/** "2 Claude Code accounts, 1 Codex account.", or nothing before an account is seen. */
export function accountsLine(accounts: UsageAccount[]): string | undefined {
  const real = realAccounts(accounts);
  const count = (agent: string, name: string) => {
    const n = real.filter((a) => a.agent === agent).length;
    return n ? `${n} ${name} account${n === 1 ? "" : "s"}` : "";
  };
  const parts = [count("claude", "Claude Code"), count("codex", "Codex")].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : undefined;
}
