import { askDetail, askSections, asksHeadline, coordinatorAsks, coordinatorName, linkWords } from "./asks";
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

it("says why an ask does not close, else its answer and what each link confirms", () => {
  const [, unclosed, , , vendors] = list.asks!;
  expect(askDetail(unclosed!)).toBe("done · a linked PR is still open");
  expect(askDetail({ ...unclosed!, mismatch: "" })).toBe("merged · t-0001 ready for review (PR open)");
  expect(askDetail(vendors!)).toBe("reading · https://example.com/vendors");
  expect(linkWords({ kind: "pr", text: "#12", target: "", thread: "t-0001", title: "", state: "merged", pr: "", prState: "merged" })).toBe("#12 merged");
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
