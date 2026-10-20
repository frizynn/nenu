import { askHeadline, askKind, askSections, asksHeadline, contextThread, coordinatorAsks, coordinatorName, foldRelated, linkChip, partText, reportBody, unclosed, type AskEntry } from "./asks";
import type { AskRow, AsksList, ProjectView } from "./types";

// Rows as `asks --json` prints them (Organizations docs/json.md, Asks), each placed by the bridge.
const ROOT = { id: "root", title: "" };
const PAY = { id: "t-0002", title: "Payments area" };
const row = (coordinator: AskRow["coordinator"], group: AskRow["group"], state: AskRow["state"], text: string, extra: Partial<AskRow> = {}): AskRow =>
  ({ project: "shop", coordinator, line: 4, state, text, answer: "", links: [], confirmed: "", mismatch: "", group, ...extra });
const list: AsksList = {
  asks: [
    row(ROOT, "waiting", "needs-decision", "Pilot with batch 2", { answer: "yes or no" }),
    row(ROOT, "unclosed", "done", "Ship the checkout", { answer: "merged", confirmed: "in-progress", mismatch: "a linked PR is still open",
      links: [{ kind: "thread", text: "t-0001", target: "t-0001", thread: "t-0001", title: "Checkout", state: "ready-for-review", pr: "https://github.com/a/b/pull/12", prState: "open" }] }),
    row(PAY, "unclosed", "working", "Land the copy fix", { confirmed: "done", mismatch: "a linked thread is resolved" }),
    row(PAY, "progress", "open", "Card tokens", { answer: "next after the copy fix" }),
    { ...row(ROOT, "progress", "working", "Compare two vendors", { answer: "reading", links: [{ kind: "page", text: "https://example.com/vendors", target: "https://example.com/vendors", thread: "", title: "", state: "", pr: "", prState: "" }] }), project: "research" },
    row(ROOT, "done", "answered", "Does it cut cost?", { answer: "yes, measured twice" }),
    { ...row(ROOT, "other", "unknown", "this line has no bullet"), project: "gone" },
  ],
  decisions: [{ project: "shop", coordinator: ROOT, text: "Install the new binary : yes or later" }],
};
const project = (slug: string, name: string): ProjectView => ({ slug, name, status: "active", threads: [] });
const projects = [project("shop", "Shop"), project("research", "Research")];

it("groups the asks in Organizations' order, the decisions after the asks that wait on you, and only projects on screen", () => {
  const sections = askSections(list, projects);
  expect(sections.map((section) => [section.label, section.entries.map((entry) => entry.text)])).toEqual([
    ["Wait on you", ["Pilot with batch 2", "Install the new binary : yes or later"]],
    ["Does not close", ["Ship the checkout", "Land the copy fix"]],
    ["In progress", ["Card tokens", "Compare two vendors"]],
    ["Done", ["Does it cut cost?"]],
  ]);
  expect(sections[0]!.entries[1]!.detail).toBe("decision");
  expect(asksHeadline(sections)).toBe("all coordinators · 2 wait on you · 2 do not close · 2 in progress · 1 done");
});

it("leaves an ask's links to their chips", () => {
  expect(sectionsFor({ project: "shop" }).flatMap((section) => section.entries).find((entry) => entry.text === "Ship the checkout")?.links).toHaveLength(1);
});

const link = (kind: "thread" | "pr" | "task" | "page", text: string, extra: Partial<AskRow["links"][number]> = {}) =>
  ({ kind, text, target: "", thread: "", title: "", state: "", pr: "", prState: "", ...extra });

it("reads each link as a short chip: what it points at, and the state Organizations confirmed", () => {
  expect(linkChip(link("thread", "t-0003", { thread: "t-0003", state: "waiting-on-you" }))).toEqual({ label: "t-0003", state: "needs you", tone: "waiting", thread: "t-0003" });
  expect(linkChip(link("thread", "t-0004", { thread: "t-0004", state: "working" }))).toMatchObject({ state: "working", tone: "moving" });
  expect(linkChip(link("thread", "t-0009", { state: "missing" }))).toEqual({ label: "t-0009", state: "missing", tone: "off" });
  expect(linkChip(link("pr", "https://github.com/a/b/pull/12", { target: "https://github.com/a/b/pull/12", state: "merged" })))
    .toEqual({ label: "#12", state: "merged", tone: "done", href: "https://github.com/a/b/pull/12" });
  expect(linkChip(link("pr", "#12", { state: "open" }))).toEqual({ label: "#12", state: "open", tone: "moving" });
  expect(linkChip(link("task", "task:AWA-569", { state: "missing" }))).toEqual({ label: "AWA-569", state: "missing", tone: "off" });
  expect(linkChip(link("page", "https://example.com/vendors", { target: "https://example.com/vendors" })))
    .toEqual({ label: "example.com", state: "", tone: "off", href: "https://example.com/vendors" });
  // A target that is not a web address is never a link.
  expect(linkChip(link("page", "javascript:alert(1)", { target: "javascript:alert(1)" }))).not.toHaveProperty("href");
});

const sectionsFor = (filter: Parameters<typeof askSections>[2]) => askSections(list, projects, filter);

it("narrows to a project, then to one of its coordinators, and names what it narrowed to", () => {
  expect(sectionsFor({ project: "research" }).flatMap((section) => section.entries.map((entry) => entry.text))).toEqual(["Compare two vendors"]);
  expect(sectionsFor({ project: "shop", coordinator: "t-0002" }).map((section) => [section.label, section.entries.map((entry) => entry.text)])).toEqual([
    ["Does not close", ["Land the copy fix"]],
    ["In progress", ["Card tokens"]],
  ]);
  // A decision is its coordinator's too.
  expect(sectionsFor({ project: "shop", coordinator: "root" })[0]!.entries.map((entry) => entry.text)).toEqual(["Pilot with batch 2", "Install the new binary : yes or later"]);
  expect(asksHeadline(sectionsFor({ project: "shop", coordinator: "t-0002" }), "Shop · Payments area")).toBe("Shop · Payments area · 0 wait on you · 1 does not close · 1 in progress · 0 done");
  // Only an ask has a line Organizations can answer on; a decision line has none.
  const waiting = sectionsFor({ project: "shop" })[0]!.entries;
  expect(waiting.map((entry) => entry.line)).toEqual([4, 0]);
});

it("hands a coordinator's card what waits on you and its other asks, and nothing without the list", () => {
  expect(coordinatorAsks(list, "shop", "root")).toEqual({
    waiting: ["Install the new binary : yes or later", "Pilot with batch 2 : yes or no"],
    asks: [list.asks![1], list.asks![5]],
  });
  expect(coordinatorAsks(list, "shop", "t-0002")?.asks.map((ask) => ask.text)).toEqual(["Land the copy fix", "Card tokens"]);
  expect(coordinatorAsks({ asks: null, decisions: [] }, "shop", "root")).toBeNull();
  expect(coordinatorAsks(null, "shop", "root")).toBeNull();
  expect([coordinatorName(ROOT), coordinatorName(PAY)]).toEqual(["Coordinator", "Payments area"]);
});

const shop = project("shop", "Shop");
const entry = (key: string, text: string, extra: Partial<AskEntry> = {}): AskEntry =>
  ({ key, group: "waiting", project: shop, coordinator: PAY, text, detail: "", links: [], line: 4, answerable: true, parts: [], ...extra });
const task = (id: string, state = "todo") => link("task", `task:${id}`, { target: id, title: `Task ${id}`, state });

it("reads an ask and the decisions about the same thread or task as one question with its parts, never across coordinators", () => {
  const folded = foldRelated([
    entry("a", "ACM-12 total in instalments", { links: [link("thread", "t-0021", { thread: "t-0021" }), task("ACM-12")] }),
    entry("b", "Pick the shop's tokens", { links: [link("thread", "t-0030", { thread: "t-0030" })] }),
    entry("d1", "ACM-12 instalments: A, B or C", { links: [link("page", "https://tracker.example.com/12")] }),
    entry("d2", "ACM-12: tell yesterday's 412 orders", { links: [] }),
    entry("d3", "ACM-120 a different task: yes or no"),
    entry("d4", "Ship t-0030's tokens", { links: [link("thread", "t-0030", { thread: "t-0030" })] }),
    entry("d5", "ACM-12 asked of another coordinator", { coordinator: ROOT }),
  ]);
  expect(folded.map((head) => [head.key, head.parts.map((part) => part.key)])).toEqual([["a", ["d1", "d2"]], ["b", ["d4"]], ["d3", []], ["d5", []]]);
  expect(partText(folded[0]!, folded[0]!.parts[0]!)).toBe("instalments: A, B or C");
  expect(partText(folded[0]!, folded[0]!.parts[1]!)).toBe("tell yesterday's 412 orders");
  expect(contextThread(folded[0]!)).toBe("t-0021");
  expect(contextThread(folded[2]!)).toBeUndefined();
});

it("folds the sections it lists, so the headline counts questions", () => {
  const sections = askSections({
    asks: [row(PAY, "waiting", "needs-decision", "ACM-12 total in instalments", { links: [task("ACM-12")] })],
    decisions: [{ project: "shop", coordinator: PAY, text: "ACM-12 instalments: A, B or C", line: 9, links: [], group: "waiting" }],
  }, projects);
  expect(sections[0]!.entries).toHaveLength(1);
  expect(sections[0]!.entries[0]!.parts.map((part) => [part.text, part.line])).toEqual([["ACM-12 instalments: A, B or C", 9]]);
});

it("says what does not close and where, and asks its coordinator in ids, never the ask's words", () => {
  const coupons = { state: "done" as const, line: 6, mismatch: "a linked task is still to do",
    links: [link("pr", "https://github.com/a/b/pull/1360", { state: "merged", thread: "t-0022" }), task("ACM-9")] };
  expect(unclosed(coupons)).toEqual({
    said: "Marked done, but task ACM-9 is still to do.", title: "Task ACM-9",
    request: 'In your STATUS.md, line 6 under "## Asked" is marked done, but task ACM-9 is still to do. Close what is still open, or update the line and say why it stays as it is. (Sent from Nenu.)',
  });
  const thread = link("thread", "t-0001", { thread: "t-0001", title: "Checkout", state: "ready-for-review", pr: "https://github.com/a/b/pull/12", prState: "open" });
  expect(unclosed({ state: "done", line: 3, mismatch: "a linked PR is still open", links: [thread] })?.said).toBe("Marked done, but PR #12 is still open.");
  const resolved = unclosed({ state: "working", line: 3, mismatch: "a linked thread is resolved", links: [{ ...thread, state: "resolved" }] })!;
  expect(resolved.said).toBe("Marked working, but thread Checkout is already resolved.");
  expect(resolved.request).toContain("thread t-0001 is already resolved");
  expect(resolved.request).not.toContain("Checkout");
  expect(unclosed({ state: "working", line: 2, mismatch: "no thread, PR or task is linked", links: [] })?.said).toBe("Marked working, but it links no thread, PR or task that shows the work.");
  // A reason this Nenu does not know is said in Organizations' words.
  expect(unclosed({ state: "done", line: 2, mismatch: "a linked review is pending", links: [] })?.said).toBe("Marked done, but a linked review is pending.");
  expect(unclosed({ state: "done", line: 2, mismatch: "", links: [] })).toBeNull();
});

it("draws a report without its Status line and its captures list, which the gallery shows", () => {
  expect(reportBody("Status: needs-decision\n\n## Summary\nPick one.\n\n## Captures\n- a.png - A\n\n## Next\nChoose")).toBe("## Summary\nPick one.\n\n## Next\nChoose");
  expect(reportBody("# Title\nStatus: done\n## Report\nText")).toBe("# Title\nStatus: done\n## Report\nText");
});

it("never folds rows that do not close: each keeps its own reason and its own ask", () => {
  const sections = askSections({
    asks: [
      row(PAY, "unclosed", "done", "Coupons in the cart", { line: 6, mismatch: "a linked task is still to do", links: [task("ACM-9")] }),
      row(PAY, "unclosed", "working", "Coupons on the receipt", { line: 7, mismatch: "a linked thread is resolved", links: [task("ACM-9"), link("thread", "t-0030", { thread: "t-0030", state: "resolved" })] }),
    ],
    decisions: [],
  }, projects);
  expect(sections[0]!.entries.map((entry) => [entry.text, entry.parts.length])).toEqual([["Coupons in the cart", 0], ["Coupons on the receipt", 0]]);
});

describe("askHeadline", () => {
  it("splits a decision at its first ` : `, into what it asks and the recommendation", () => {
    expect(askHeadline({ text: "Stock : que AWAM sea la fuente : recomiendo sí", detail: "decision" })).toEqual({ title: "Stock", body: "que AWAM sea la fuente : recomiendo sí" });
    expect(askHeadline({ text: "Rotar la clave", detail: "decision" })).toEqual({ title: "Rotar la clave", body: "" });
  });

  it("gives an ask its coordinator's answer as the second line", () => {
    expect(askHeadline({ text: "Cuotas", detail: "Dos opciones; recomiendo 3" })).toEqual({ title: "Cuotas", body: "Dos opciones; recomiendo 3" });
  });

  it("names only what waits on you", () => {
    expect(askKind({ group: "waiting", detail: "decision" })).toBe("decision");
    expect(askKind({ group: "waiting", detail: "" })).toBe("ask");
    expect(askKind({ group: "progress", detail: "decision" })).toBeUndefined();
  });
});
