import { askDetail, askSections, asksHeadline, coordinatorAsks, coordinatorName, linkChip } from "./asks";
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

it("says why an ask does not close, else its answer, and leaves its links to their chips", () => {
  const [, unclosed, , , vendors] = list.asks!;
  expect(askDetail(unclosed!)).toBe("done · a linked PR is still open");
  expect(askDetail({ ...unclosed!, mismatch: "" })).toBe("merged");
  expect(askDetail(vendors!)).toBe("reading");
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
