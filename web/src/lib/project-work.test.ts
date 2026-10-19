import { describe, expect, it } from "vitest";

import { cardSummary, finishedCount, routineRecipient, routineRecipientShort, routinesFor, routineWhen, waitingGroups, workCards } from "./project-work";
import type { AsksList, ProjectThreadView, ProjectView, RoutineView } from "./types";

const node = (id: string, title: string, parentId: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title, parentId, role: "worker", status: "open", group: "working", ...extra });
const coordinator = (id: string, title: string, parentId = "root", extra: Partial<ProjectThreadView> = {}) => node(id, title, parentId, { role: "coordinator", ...extra });
const project = (threads: ProjectThreadView[]): ProjectView => ({ slug: "acme", name: "Acme", status: "active", threads });
const routine = (name: string, extra: Partial<RoutineView> = {}): RoutineView =>
  ({ name, trigger: "schedule", to: "", parent: "", prompt: "", schedule: "daily 09:00", events: [], enabled: true, lastRun: "", nextRun: "", ...extra });

describe("workCards", () => {
  const threads = [
    coordinator("t-0001", "Billing"),
    node("t-0002", "Invoices", "t-0001"),
    coordinator("t-0003", "Exports", "t-0001"),
    node("t-0004", "CSV", "t-0003", { group: "waiting-on-you", status: "failed" }),
    node("t-0005", "Loose", "root"),
    node("t-0006", "Old invoice", "t-0001", { status: "resolved", updated: "2026-10-01T00:00:00Z" }),
    node("t-0007", "Old loose", "root", { status: "resolved", updated: "2026-10-02T00:00:00Z" }),
    coordinator("t-0008", "Done front", "root", { status: "resolved", updated: "2026-10-03T00:00:00Z" }),
    node("t-0009", "Its work", "t-0008", { status: "resolved", updated: "2026-10-03T00:00:00Z" }),
  ];

  it("gives each open coordinator, nested ones too, its own open threads, and the project coordinator's card last", () => {
    const cards = workCards(project(threads), "open");
    expect(cards.map((card) => [card.coordinator?.thread.id ?? "root", card.rows.map((row) => row.thread.id)])).toEqual([
      ["t-0001", ["t-0002"]], ["t-0003", ["t-0004"]], ["root", ["t-0005"]],
    ]);
  });

  it("gives Finished the resolved threads by who ran them, open coordinators before finished ones", () => {
    const cards = workCards(project(threads), "finished");
    expect(cards.map((card) => [card.coordinator?.thread.id ?? "root", card.rows.map((row) => row.thread.id)])).toEqual([
      ["t-0001", ["t-0006"]], ["t-0008", ["t-0009"]], ["root", ["t-0007"]],
    ]);
    expect(finishedCount(project(threads))).toBe(4);
  });

  it("says what waits on you, then what its threads are doing", () => {
    const [billing] = workCards(project([...threads, node("t-0010", "Review me", "t-0001", { group: "ready-for-review" })]), "open");
    expect(cardSummary(billing!.rows, 2).map((part) => part.text)).toEqual(["2 waiting on you", "1 to review", "1 working"]);
  });
});

describe("routines", () => {
  const threads = [coordinator("t-0001", "Billing"), node("t-0002", "Invoices", "t-0001")];

  it("reads a missing `to` as Organizations does: root for a schedule, the pull request's owner otherwise", () => {
    expect(routineRecipient(routine("nightly"), threads)).toBe("The project coordinator");
    expect(routineRecipientShort(routine("pr", { trigger: "pr" }), threads)).toBe("to the PR's thread");
  });

  it("names a node by id or title, and a new thread by where it starts", () => {
    expect(routineRecipient(routine("a", { to: "node:t-0001" }), threads)).toBe("Billing");
    expect(routineRecipient(routine("b", { to: "node:Billing" }), threads)).toBe("Billing");
    expect(routineRecipient(routine("c", { to: "node:gone" }), threads)).toBe("gone");
    expect(routineRecipient(routine("d", { to: "new", parent: "t-0001" }), threads)).toBe("A new thread under Billing");
  });

  it("lists for a coordinator only the routines that reach it", () => {
    const list = [routine("root"), routine("billing", { to: "node:Billing" }), routine("pr", { trigger: "pr" }), routine("new", { to: "new", parent: "t-0001" })];
    expect(routinesFor(list, "root", threads).map((r) => r.name)).toEqual(["root"]);
    expect(routinesFor(list, "t-0001", threads).map((r) => r.name)).toEqual(["billing"]);
  });

  it("says when: the schedule as written, or the pull request events in words", () => {
    expect(routineWhen(routine("a"))).toBe("daily 09:00");
    expect(routineWhen(routine("b", { trigger: "pr", events: ["checks-failed", "review"] }))).toBe("When checks fail or a review lands");
    expect(routineWhen(routine("c", { trigger: "pr" }))).toBe("When a pull request opens, checks fail, a review lands or it merges");
  });
});

describe("waitingGroups", () => {
  it("groups what waits on you by coordinator, in the list's order, counting each part", () => {
    const list: AsksList = {
      answers: true,
      asks: [
        { project: "acme", coordinator: { id: "t-0001", title: "Billing" }, line: 3, text: "Pick a plan", answer: "", links: [], group: "waiting", state: "needs-decision" },
        { project: "acme", coordinator: { id: "root", title: "" }, line: 4, text: "Ship it?", answer: "", links: [], group: "waiting", state: "needs-decision" },
        { project: "acme", coordinator: { id: "t-0001", title: "Billing" }, line: 5, text: "Done thing", answer: "", links: [], group: "done", state: "done" },
      ],
      decisions: [{ project: "acme", coordinator: { id: "t-0001", title: "Billing" }, text: "Refund?", line: 9 }],
    } as unknown as AsksList;
    expect(waitingGroups(list, project([])).map((group) => [group.coordinator.id, group.count])).toEqual([["t-0001", 2], ["root", 1]]);
  });
});
