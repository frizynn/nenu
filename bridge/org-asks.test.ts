import { describe, expect, test } from "bun:test";

import { askGroup, parseAsk, readAsks } from "./org-asks.ts";
import type { OrgRun } from "./org-cli.ts";

const answer = (code: number, stdout: string, stderr = ""): OrgRun => async () => ({ code, stdout, stderr });

describe("readAsks", () => {
  test("reads every row of `asks --json`, in Organizations' order, under the registry's root", async () => {
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const run: OrgRun = async (argv, opts) => {
      calls.push({ argv, env: opts.env });
      return { code: 0, stdout: JSON.stringify({ schema_version: 1, asks: [
        { project: "demo", coordinator: { id: "t-0001", title: "Checkout" }, line: 4, state: "working", text: "Copy fix", answer: "landing it", links: [], confirmed: "done", mismatch: "a linked thread is resolved" },
        { project: "demo", coordinator: { id: "root", title: "" }, line: 2, state: "open", text: "Docs", answer: "", links: [], confirmed: "", mismatch: "" },
      ] }), stderr: "" };
    };
    const rows = await readAsks(run, "/projects");
    expect(calls).toEqual([{ argv: ["asks", "--json"], env: { HERDR_PROJECTS_ROOT: "/projects" } }]);
    expect(rows?.map((row) => [row.coordinator.id, row.text, row.mismatch])).toEqual([["t-0001", "Copy fix", "a linked thread is resolved"], ["root", "Docs", ""]]);
  });

  test("an Organizations without the document answers null; a read that failed throws", async () => {
    // As 0856581, before `asks` existed, answers (measured).
    expect(await readAsks(answer(2, "", "error: unrecognized subcommand 'asks'\n\n  tip: a similar subcommand exists: 'task'"), "/p")).toBeNull();
    expect(await readAsks(answer(0, JSON.stringify({ schema_version: 2, asks: [] })), "/p")).toBeNull();
    expect(await readAsks(answer(0, JSON.stringify({ schema_version: 1 })), "/p")).toBeNull();
    expect(await readAsks(answer(0, JSON.stringify({ schema_version: 1, asks: [] })), "/p")).toEqual([]);
    await expect(readAsks(answer(124, "", ""), "/p")).rejects.toThrow("asks --json failed (124)");
    await expect(readAsks(answer(0, "not json"), "/p")).rejects.toThrow();
  });

  test("a row without its project, coordinator or a known state is skipped", async () => {
    const good = { project: "demo", coordinator: { id: "root", title: "" }, state: "open", text: "Docs" };
    const rows = await readAsks(answer(0, JSON.stringify({ schema_version: 1, asks: [
      good, { ...good, project: 7 }, { ...good, coordinator: { id: "" } }, { ...good, state: "later" }, "nope",
    ] })), "/p");
    expect(rows).toHaveLength(1);
  });
});

describe("parseAsk", () => {
  test("keeps only the links of a kind it knows, and a confirmation from a newer Organizations confirms nothing", () => {
    expect(parseAsk({
      line: 3, state: "done", text: "Ship it", answer: "merged", confirmed: "half-done", mismatch: "",
      links: [{ kind: "pr", text: "#12", target: "https://github.com/a/b/pull/12", thread: "t-0001", title: "Checkout", state: "merged", pr: "https://github.com/a/b/pull/12", pr_state: "merged" }, { kind: "ticket", text: "X-1" }],
    })).toEqual({
      line: 3, state: "done", text: "Ship it", answer: "merged", confirmed: "", mismatch: "",
      links: [{ kind: "pr", text: "#12", target: "https://github.com/a/b/pull/12", thread: "t-0001", title: "Checkout", state: "merged", pr: "https://github.com/a/b/pull/12", prState: "merged" }],
    });
  });
});

describe("askGroup", () => {
  test("follows Organizations' rank: waits on you, does not close, in progress, done, other lines", () => {
    const ask = (state: Parameters<typeof askGroup>[0]["state"], mismatch = "") => ({ state, mismatch });
    expect(askGroup(ask("needs-decision"), false)).toBe("waiting");
    // A decision outranks a mismatch, as in the popup.
    expect(askGroup(ask("needs-decision", "a linked PR is merged"), false)).toBe("waiting");
    expect(askGroup(ask("needs-decision"), true)).toBe("progress");
    expect(askGroup(ask("done", "a linked PR is still open"), false)).toBe("unclosed");
    expect(askGroup(ask("working", "no thread, PR or task is linked"), false)).toBe("unclosed");
    expect(askGroup(ask("open"), false)).toBe("progress");
    expect(askGroup(ask("working"), false)).toBe("progress");
    expect(askGroup(ask("answered"), false)).toBe("done");
    expect(askGroup(ask("done"), false)).toBe("done");
    expect(askGroup(ask("unknown"), false)).toBe("other");
  });
});
