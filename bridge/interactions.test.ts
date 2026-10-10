import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import type { HerdrClient, PaneRead } from "./herdr-client.ts";
import type { InteractionLookup } from "./push.ts";
import { dialogOnScreen, Interactions, pushActions, toInteraction, type DetectedInteraction, type PaneIO } from "./interactions.ts";
import { LiveEvents } from "./live-events.ts";
import { parseAnswer } from "./routes/interactions.ts";
import { startServer } from "./server.ts";
import { StateEngine } from "./state-engine.ts";
import type { AgentView, InteractionHint, LiveEvent } from "./types.ts";

const ROOT = join(import.meta.dir, "..");
const PANES = join(ROOT, "web/src/fixtures/panes");
const fixture = (name: string, dir = PANES) => readFileSync(join(dir, name), "utf8");
const agentOf = (file: string) => (file.startsWith("claude-lab--") ? "claude" : file.split("--")[0]!);

/** What every dialog in the corpus becomes: kind, then each option as label=role, in order. */
const EXPECTED: Record<string, string> = {
  // web/src/fixtures/panes
  "agy--permission-bash.txt": "permission: Yes=primary | Yes, and always allow in this conversation for commands that start with 'ls'=persistent | Yes, and always allow for commands that start with 'ls' (Persist to settings.json)=persistent | No=deny",
  "agy--permission-edit.txt": "permission: Yes=primary | Yes, and always allow in this conversation for commands that start with 'cat << 'EOF' > test_logger.py=persistent | Yes, and always allow for commands that start with 'cat << 'EOF' > test_logger.py=persistent | No=deny",
  "agy--plan-approval.txt": "plan: Execute plan=primary | Request changes=deny | Cancel=deny",
  "agy--select-menu.txt": "question: Red=neutral | Green=neutral | Blue=neutral",
  "agy--trust-prompt.txt": "permission: Yes, I trust this folder=persistent | No, exit=deny",
  "claude--menu-effort-slider--w120.txt": "menu: Confirm=neutral | This session only=persistent | Cancel=deny",
  "claude--menu-effort-slider.txt": "menu: Confirm=neutral | This session only=persistent | Cancel=deny",
  "claude--menu-model-picker-haiku.txt": "menu: Set as default=persistent | Use this session only=persistent | Cancel=deny",
  "claude--menu-model-picker-moved.txt": "menu: Set as default=persistent | Use this session only=persistent | Cancel=deny",
  "claude--menu-model-picker-wrapped.txt": "menu: Set as default=persistent | Use this session only=persistent | Cancel=deny",
  "claude--menu-model-picker.txt": "menu: Set as default=persistent | Use this session only=persistent | Cancel=deny",
  "claude--permission-bash.txt": "permission: Yes=primary | Yes, and don’t ask again for: mkfifo fixture-fifo *=persistent | No=deny",
  "claude--permission-edit.txt": "permission: Yes=primary | Yes, allow all edits during this session (shift+tab)=persistent | No=deny",
  "claude--plan-approval--feedback-focused.txt": "plan: Yes, clear context (5% used) and use auto mode=persistent | Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval--feedback-typed.txt": "plan: Yes, clear context (4% used) and use auto mode=persistent | Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval--feedback-wrapped.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval--numbered-body.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | No, refine with Ultraplan on Claude Code on the web=deny | Tell Claude what to change=freeText",
  "claude--plan-approval--three-row-focused.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval--three-row-typed-focused.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval--three-row.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | No, refine with Ultraplan on Claude Code on the web=deny | Tell Claude what to change=freeText",
  "claude--select-menu.txt": "question: Red=neutral | Green=neutral | Blue=neutral | Chat about this=deny | Type something.=freeText",
  "claude--select-multi.txt": "wizard: Plan first=neutral | Just build it=neutral | Build + verify=neutral | Chat about this=deny",
  "claude--select-multiselect-checked.txt": "multi-select: Cheese=neutral | Mushrooms=neutral | Olives=neutral | Peppers=neutral | Type something=freeText | Submit=primary | Chat about this=deny",
  "claude--select-multiselect-review.txt": "multi-select: Submit answers=primary | Cancel=deny",
  "claude--select-multiselect-single.txt": "multi-select: Cheese=neutral | Mushrooms=neutral | Olives=neutral | Peppers=neutral | Type something=freeText | Submit=primary | Chat about this=deny",
  "claude--select-preview-note-attached.txt": "question: Boxy=neutral | Rounded=neutral | Minimal=neutral",
  "claude--select-preview-note-input.txt": "question: Boxy=neutral | Rounded=neutral | Minimal=neutral",
  "claude--select-preview.txt": "question: Boxy=neutral | Rounded=neutral | Minimal=neutral",
  "claude--trust-prompt.txt": "permission: Yes, I trust this folder=persistent | No, exit=deny",
  "claude--v2285-ask-multi.txt": "multi-select: Apple=neutral | Banana=neutral | Cherry=neutral | Type something=freeText | Submit=primary | Chat about this=deny",
  "claude--v2285-ask-question.txt": "question: Apple=neutral | Banana=neutral | Chat about this=deny | Type something.=freeText",
  "claude--v2285-ask-wizard.txt": "wizard: Apple=neutral | Banana=neutral | Chat about this=deny",
  "claude--wizard-multiselect-checked.txt": "multi-select: Pepperoni=neutral | Mushrooms=neutral | Bell peppers=neutral | Extra cheese=neutral | Next=primary | Chat about this=deny",
  "claude--wizard-multiselect-final.txt": "multi-select: Garlic knots=neutral | Caesar salad=neutral | Dipping sauces=neutral | Submit=primary | Chat about this=deny",
  "claude--wizard-multiselect-pointer-next.txt": "multi-select: Pepperoni=neutral | Mushrooms=neutral | Bell peppers=neutral | Extra cheese=neutral | Next=primary | Chat about this=deny",
  "claude--wizard-multiselect-q1.txt": "multi-select: Pepperoni=neutral | Mushrooms=neutral | Bell peppers=neutral | Extra cheese=neutral | Next=primary | Chat about this=deny",
  "claude--wizard-preview-note-attached.txt": "question: Grid=neutral | List=neutral",
  "claude--wizard-preview-q1.txt": "question: Grid=neutral | List=neutral",
  "claude--wizard-preview-wrapped-label.txt": "question: Grid of equal-width cards with a fixed gutter (Recommended)=neutral | List=neutral",
  "claude--wizard-q1-revisit.txt": "wizard: Parser=neutral | UI=neutral | Tests=neutral | Chat about this=deny",
  "claude--wizard-q1.txt": "wizard: Parser=neutral | UI=neutral | Tests=neutral | Chat about this=deny",
  "claude--wizard-q2.txt": "wizard: Small=neutral | Medium=neutral | Large=neutral | Chat about this=deny",
  "claude--wizard-submit-unanswered.txt": "wizard: Submit answers=primary | Cancel=deny",
  "claude--wizard-submit.txt": "wizard: Submit answers=primary | Cancel=deny",
  "claude-lab--menu-config-panel--w82.txt": "menu: Tabs=neutral | Clear=deny",
  "claude-lab--menu-effort-slider--w82.txt": "menu: Confirm=neutral | This session only=persistent | Cancel=deny",
  "claude-lab--menu-model-picker--w82.txt": "menu: Set as default=persistent | Use this session only=persistent | Cancel=deny",
  "claude-lab--menu-resume-picker--w83.txt": "menu: Rename=neutral | Cancel=deny",
  "claude-lab--menu-rewind--w82.txt": "menu: Continue=neutral | Cancel=deny",
  "claude-lab--permission-bash--w40.txt": "permission: Yes=primary | Yes, and always allow access to=persistent | Yes, and switch to auto mode ·=persistent | Nor you=neutral",
  "claude-lab--permission-bash--w82.txt": "permission: Yes=primary | Yes, and always allow access to /tmp/claude-lab/project from this project=persistent | Yes, and switch to auto mode · auto mode handles these prompts for you=persistent | No=deny",
  "claude-lab--permission-write--w82.txt": "permission: Yes=primary | Yes, and switch to accept edits (auto-approve file edits and common file=persistent | No=deny",
  "claude-lab--tasks-panel--w82.txt": "menu: View=neutral | Close=deny",
  "codex--approval-exec.txt": "permission: Yes, proceed=primary | No, and tell Codex what to do differently=deny",
  "codex--ask-fruit.txt": "question: Apple (Recommended)=neutral | Pear=neutral | None of the above=neutral",
  "codex--ask-wizard-q1.txt": "question: Tabs (Recommended)=neutral | Spaces=neutral | None of the above=neutral",
  "codex--ask-wizard-q2.txt": "question: Yes (Recommended)=neutral | No=neutral | None of the above=neutral",
  "codex--trust-prompt.txt": "permission: Yes, continue=persistent | No, quit=deny",
  "codex--v0156-approval-exec-2opt.txt": "permission: Yes, proceed=primary | No, and tell Codex what to do differently=deny",
  "codex--v0156-approval-exec-wrapped-50.txt": "permission: Yes, proceed=primary | No, and tell Codex what to do differently=deny",
  "codex--v0156-approval-exec-wrapped.txt": "permission: Yes, proceed=primary | No, and tell Codex what to do differently=deny",
  "codex--v0156-approval-patch.txt": "permission: Yes, proceed=primary | No, and tell Codex what to do differently=deny",
  "codex--v0156-trust.txt": "permission: Trust and continue=persistent | Quit=deny",
  "codex--v0159-update-dialog.txt": "menu: Continue=neutral | Skip=deny",
  "grok--ask-color-moved.txt": "question: Red=neutral | Green=neutral | Blue=neutral",
  "grok--ask-color.txt": "question: Red=neutral | Green=neutral | Blue=neutral",
  "grok--ask-esc-park.txt": "question: Apple=neutral | Pear=neutral",
  "grok--ask-size.txt": "question: Small=neutral | Large=neutral",
  "grok--ask-wizard-q1.txt": "question: Grid=neutral | List=neutral",
  "grok--ask-wizard-q2.txt": "question: Yes=neutral | No=neutral",
  "grok--ask-z-focused.txt": "question: Small=neutral | Large=neutral",
  "grok--ask-z-parked.txt": "question: Red=neutral | Blue=neutral",
  "grok--ask-z-typed.txt": "question: Small=neutral | Large=neutral",
  "grok--permission-edit.txt": "permission: Yes=primary | No, reject=deny",
  "grok--permission-rm-feedback.txt": "permission: Yes, proceed=primary | No, reject=deny",
  "grok--permission-rm-moved.txt": "permission: Yes, proceed=primary | No, reject=deny",
  "grok--permission-rm.txt": "permission: Yes, proceed=primary | No, reject=deny",
  "grok--plan-approval.txt": "menu: Comment=neutral | Copy plan=neutral | Approve=neutral | Quit plan=deny | Select=neutral | Prompt=neutral",
  "grok--plan-request-changes.txt": "menu: Approve=neutral | Plan=neutral | Back=deny",
  "grok--plan-tab-prompt.txt": "menu: Approve=neutral | Plan=neutral | Back=deny",
  // web/src/lib/harness/claude/fixtures
  "ask-multiselect-v2296.txt": "multi-select: Apple=neutral | Banana=neutral | Cherry=neutral | Type something=freeText | Submit=primary | Chat about this=deny",
  "ask-review-v2296.txt": "multi-select: Submit answers=primary | Cancel=deny",
  "ask-type-something-filled-v2296.txt": "multi-select: Apple=neutral | Banana=neutral | Cherry=neutral | Mango=neutral | Submit=primary | Chat about this=deny",
  "ask-type-something-focused-v2296.txt": "multi-select: Apple=neutral | Banana=neutral | Cherry=neutral | Type something=freeText | Submit=primary | Chat about this=deny",
  "ask-type-something-typed-v2296.txt": "multi-select: Apple=neutral | Banana=neutral | Cherry=neutral | Mango=neutral | Submit=primary | Chat about this=deny",
  "permission-bash-v2296.txt": "permission: Yes=primary | Yes, and always allow access to /private/tmp/claude-501/nenu-probe from this project=persistent | Yes, and switch to auto mode · auto mode handles these prompts for you=persistent | No=deny",
  "permission-bash-amend-typed-v2296.txt": "permission: Yes, and always allow access to /private/tmp/claude-501/nenu-probe from this project=persistent | Yes, and switch to auto mode · auto mode handles these prompts for you=persistent | No=deny",
  "permission-bash-amend-v2296.txt": "permission: Yes, and always allow access to /private/tmp/claude-501/nenu-probe from this project=persistent | Yes, and switch to auto mode · auto mode handles these prompts for you=persistent | No=deny",
  "permission-deny-amend-typed-v2296.txt": "permission: Yes=primary | Yes, and always allow access to /private/tmp/claude-501/nenu-probe from this project=persistent | Yes, and switch to auto mode · auto mode handles these prompts for you=persistent",
  "permission-pointer-mid-v2296.txt": "permission: Yes=primary | Yes, and always allow access to=persistent | Yes, and switch to auto mode · auto mode handles these prompts for you=persistent | No=deny",
  "plan-approval-v2296.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  // web/src/lib/harness/codex/fixtures
  "approval-exec-v0160.txt": "permission: Yes, proceed=primary | No, and tell Codex what to do differently=deny",
  "ask-notes-row-pointed-v0160.txt": "question: Apple=neutral | Banana=neutral | None of the above=neutral",
  "ask-plan-mode-v0160.txt": "question: Apple=neutral | Banana=neutral | None of the above=neutral",
  "model-picker.txt": "menu: Confirm=neutral | Go back=deny",
  "model-reasoning.txt": "menu: Confirm=neutral | Go back=deny",
  "trust-v0160.txt": "permission: Trust and continue=persistent | Quit=deny",
};

const CORPUS: Array<[string, string, (file: string) => string]> = [
  ["web/src/fixtures/panes", PANES, agentOf],
  ["web/src/lib/harness/claude/fixtures", join(ROOT, "web/src/lib/harness/claude/fixtures"), () => "claude"],
  ["web/src/lib/harness/codex/fixtures", join(ROOT, "web/src/lib/harness/codex/fixtures"), () => "codex"],
];

describe("the fixture corpus", () => {
  for (const [, dir, agent] of CORPUS) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".txt")).sort()) {
      test(file, () => {
        const text = fixture(file, dir);
        const dialog = dialogOnScreen(agent(file), text);
        const got = dialog
          ? (({ interaction: i }) => `${i.kind}: ${i.options.map((o) => `${o.label}=${o.role}`).join(" | ")}`)(
            toInteraction({ paneId: "p", agent: agent(file) }, dialog, 0, [], 0))
          : undefined;
        expect(got).toBe(EXPECTED[file]);
      });
    }
  }
});

const blocked = (paneId: string, agent = "claude", status: AgentView["status"] = "blocked"): AgentView =>
  ({ paneId, agent, status, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", cwd: "/tmp", focused: false });

function detect(file: string, hints: InteractionHint[] = [], agent = agentOf(file), above = ""): DetectedInteraction {
  const text = above + fixture(file);
  return toInteraction({ paneId: "p", agent }, dialogOnScreen(agent, text)!, 0, hints, 0).interaction;
}

describe("hints enrich, the screen decides", () => {
  test("a permission hint whose command is on screen completes the card", () => {
    const i = detect("claude--permission-bash.txt", [{ source: "claude-hook", observedAt: 1, question: "Bash", detail: "mkfifo fixture-fifo" }]);
    expect(i.detailComplete).toBe(true);
    // The screen's own subject stays, so the card still says which tool is asking.
    expect(i.context).toBe(detect("claude--permission-bash.txt").context!);
    expect(i.context).toContain("Bash command");
    expect(i.context).toContain("mkfifo fixture-fifo");
    expect(i.hints?.length).toBe(1);
  });

  test("a permission hint for another command is dropped", () => {
    const i = detect("claude--permission-bash.txt", [{ source: "claude-hook", observedAt: 1, question: "Bash", detail: "rm -rf /" }]);
    expect(i.detailComplete).toBe(false);
    expect(i.hints).toBeUndefined();
    expect(i.context).toContain("mkfifo fixture-fifo");
  });

  test("a hint whose command is only in the scrollback above the dialog is dropped", () => {
    const i = detect("claude--permission-bash.txt", [{ source: "claude-hook", observedAt: 1, question: "Bash", detail: "git push --force origin main" }], "claude", "⏺ Bash(git push --force origin main)\n  ⎿  done\n\n");
    expect(i.detailComplete).toBe(false);
    expect(i.hints).toBeUndefined();
    expect(i.context).toContain("mkfifo fixture-fifo");
    expect(pushActions(i)).toEqual([]);
  });

  test("a hint naming only part of the on-screen command is dropped", () => {
    const i = detect("claude--permission-bash.txt", [{ source: "claude-hook", observedAt: 1, question: "Bash", detail: "mkfifo" }]);
    expect(i.detailComplete).toBe(false);
    expect(i.context).toContain("mkfifo fixture-fifo");
  });

  test("a command the dialog wraps over two rows still matches its hint", () => {
    const i = detect("claude-lab--permission-bash--w40.txt", [{ source: "claude-hook", observedAt: 1, detail: "touch /tmp/claude-lab/project/scratch-one.txt" }], "claude");
    expect(i.detailComplete).toBe(true);
  });

  test("a Codex command matches its hint without the screen's $ prompt", () => {
    const i = detect("codex--approval-exec.txt", [{ source: "codex-rpc", observedAt: 1, detail: "touch /tmp/collie-codex-probe.txt" }]);
    expect(i.detailComplete).toBe(true);
  });

  test("a question hint with the screen's options lends its full text; other options are dropped", () => {
    const agreeing = detect("claude--select-menu.txt", [{ source: "claude-journal", observedAt: 1, question: "Which color theme should the dashboard use? (pick one)", options: ["Red", "Green", "Blue"] }]);
    expect(agreeing.question).toBe("Which color theme should the dashboard use? (pick one)");
    const foreign = detect("claude--select-menu.txt", [{ source: "claude-journal", observedAt: 1, question: "Which color theme should the dashboard use?", options: ["Teal", "Pink"] }]);
    expect(foreign.question).toBe("Which color theme should the dashboard use?");
    expect(foreign.hints).toBeUndefined();
  });

  test("a pending plan whose tail is on screen becomes the plan card's context", () => {
    const plan = "## Change\n\nCreate haiku.txt\n\n## Verification\n\n- Confirm the file exists and contains exactly three lines.\n- Read it back to confirm the 5–7–5 structure and dog theme.";
    const i = detect("claude--plan-approval.txt", [{ source: "claude-journal", observedAt: 1, detail: plan }]);
    expect(i.context).toBe(plan);
  });

  test("a plan hint for another plan is dropped", () => {
    const i = detect("claude--plan-approval.txt", [{ source: "claude-hook", observedAt: 1, detail: "# Plan\n1. Write haiku.txt" }]);
    expect(i.context).toBeUndefined();
    expect(i.hints).toBeUndefined();
  });

  test("hints never change the options or the signature", () => {
    const plain = detect("claude--permission-bash.txt");
    const hinted = detect("claude--permission-bash.txt", [{ source: "claude-hook", observedAt: 1, detail: "mkfifo fixture-fifo" }]);
    expect(hinted.options).toEqual(plain.options);
    expect(hinted.signature).toBe(plain.signature);
  });
});

describe("push actions", () => {
  test("a question with two one-tap answers gets both", () => {
    expect(pushActions(detect("claude--v2285-ask-question.txt"))).toEqual([
      { optionIndex: 0, title: "Apple" }, { optionIndex: 1, title: "Banana" },
    ]);
  });

  test("a permission gets actions only when its full command is on the card, never the persistent row", () => {
    expect(pushActions(detect("claude--permission-bash.txt"))).toEqual([]);
    const complete = detect("claude--permission-bash.txt", [{ source: "claude-hook", observedAt: 1, detail: "mkfifo fixture-fifo" }]);
    expect(pushActions(complete)).toEqual([{ optionIndex: 0, title: "Yes" }, { optionIndex: 2, title: "No" }]);
  });

  test("a question's No is an answer, not a deny the notification leaves out", () => {
    expect(pushActions(detect("grok--ask-wizard-q2.txt"))).toEqual([{ optionIndex: 0, title: "Yes" }, { optionIndex: 1, title: "No" }]);
    expect(pushActions(detect("codex--ask-wizard-q2.txt"))).toEqual([]);
  });

  test("nothing while a preview question's note is being typed", () => {
    expect(detect("claude--wizard-preview-q1.txt").typing).toBeUndefined();
    const editing = detect("claude--select-preview-note-input.txt");
    expect(editing.typing).toBe(true);
    expect(pushActions(editing)).toEqual([]);
  });

  test("plans, menus and questions with more than two answers open the app instead", () => {
    expect(pushActions(detect("claude--plan-approval.txt"))).toEqual([]);
    expect(pushActions(detect("claude--menu-model-picker.txt"))).toEqual([]);
    expect(pushActions(detect("claude--select-menu.txt"))).toEqual([]);
  });
});

/** A scripted pane: `screens[key]` is what the pane shows after that key; every call is logged. */
function scriptedPane(initial: string, screens: Record<string, string> = {}) {
  let screen = initial;
  const log = { reads: 0, keys: [] as string[][], text: [] as string[] };
  const io: PaneIO = {
    async readPane(): Promise<PaneRead> {
      log.reads++;
      return { pane_id: "p", text: screen, truncated: false, revision: 0 };
    },
    async sendPaneKeys(_pane, keys) {
      log.keys.push(keys);
      for (const k of keys) if (screens[k] !== undefined) screen = screens[k]!;
    },
    async sendPaneText(_pane, text) {
      log.text.push(text);
      if (screens[`text:${text}`] !== undefined) screen = screens[`text:${text}`]!;
    },
  };
  return { io, log, show: (text: string) => { screen = text; } };
}

function recorder() {
  const events: LiveEvent[] = [];
  return { events, live: { publish: (e: LiveEvent) => void events.push(e) } };
}

const noSleep = async () => {};

describe("Interactions.list", () => {
  test("reuses a read from the last two seconds and shares a list already running", async () => {
    let now = 1_000;
    const interactions = new Interactions(recorder().live, { sleep: noSleep, now: () => now });
    const pane = scriptedPane(fixture("claude--permission-edit.txt"));
    const [a, b] = await Promise.all([interactions.list("s", pane.io, [blocked("p")]), interactions.list("s", pane.io, [blocked("p")])]);
    expect(a).toEqual(b);
    expect(pane.log.reads).toBe(1);
    now += 1_999;
    expect((await interactions.list("s", pane.io, [blocked("p")])).length).toBe(1);
    expect(pane.log.reads).toBe(1);
    now += 1;
    await interactions.list("s", pane.io, [blocked("p")]);
    expect(pane.log.reads).toBe(2);
  });
});

describe("Interactions.refresh", () => {
  test("reads only blocked panes, and parses a pane again only when its screen changed", async () => {
    const { events, live } = recorder();
    const interactions = new Interactions(live, { sleep: noSleep, now: () => 5 });
    const pane = scriptedPane(fixture("claude--permission-edit.txt"));
    const idle = blocked("idle", "claude", "idle");
    const first = await interactions.refresh("s", pane.io, [blocked("p"), idle]);
    expect(first.map((i) => i.question)).toEqual(["Do you want to create hello.txt?"]);
    expect(pane.log.reads).toBe(1);
    expect(events).toEqual([{ session: "s", topic: "interaction", paneId: "p" }]);

    const again = await interactions.refresh("s", pane.io, [blocked("p"), idle]);
    expect(again[0]).toBe(first[0]!); // the same object: nothing was re-parsed
    expect(events.length).toBe(1);

    pane.show(fixture("claude--permission-bash.txt"));
    await interactions.refresh("s", pane.io, [blocked("p")]);
    expect(interactions.current("s", "p")?.question).toBe("Do you want to proceed?");
    expect(events.length).toBe(2);
  });

  test("a pane that stops being blocked loses its card and says so", async () => {
    const { events, live } = recorder();
    const interactions = new Interactions(live, { sleep: noSleep });
    const pane = scriptedPane(fixture("claude--permission-edit.txt"));
    await interactions.refresh("s", pane.io, [blocked("p")]);
    await interactions.refresh("s", pane.io, [blocked("p", "claude", "working")]);
    expect(interactions.current("s", "p")).toBeNull();
    expect(events.map((e) => e.topic)).toEqual(["interaction", "interaction"]);
  });

  test("a dialog-regex match makes a not-yet-blocked pane eligible", async () => {
    const interactions = new Interactions(recorder().live, { sleep: noSleep });
    const pane = scriptedPane(fixture("codex--approval-exec.txt"));
    const working = blocked("p", "codex", "working");
    expect(await interactions.refresh("s", pane.io, [working])).toEqual([]);
    interactions.noteOutputMatched("s", "p");
    expect((await interactions.refresh("s", pane.io, [working]))[0]?.kind).toBe("permission");
  });

  test("a hint arriving later re-publishes the card", async () => {
    const { events, live } = recorder();
    const interactions = new Interactions(live, { sleep: noSleep });
    const pane = scriptedPane(fixture("claude--permission-bash.txt"));
    let hints: InteractionHint[] = [];
    const source = async () => hints;
    await interactions.refresh("s", pane.io, [blocked("p")], source);
    hints = [{ source: "claude-hook", observedAt: 1, detail: "mkfifo fixture-fifo" }];
    await interactions.refresh("s", pane.io, [blocked("p")], source);
    expect(interactions.current("s", "p")?.detailComplete).toBe(true);
    expect(events.length).toBe(2);
  });
});

describe("Interactions.follow", () => {
  test("a herd change and a dialog-regex match re-detect without a client asking", async () => {
    const hub = new LiveEvents();
    const published: string[] = [];
    hub.subscribe((e) => void published.push(`${e.topic}:${e.paneId ?? ""}`));
    const interactions = new Interactions(hub, { sleep: noSleep });
    const pane = scriptedPane(fixture("claude--permission-edit.txt"));
    let agents = [blocked("p", "claude", "working")];
    let matched: ((e: { paneId: string }) => void) | undefined;
    const rt = { name: "s", herdr: pane.io, engine: { current: () => ({ agents }) }, poker: { onOutputMatched: (cb: (e: { paneId: string }) => void) => { matched = cb; return () => {}; } } };
    interactions.follow({ get: (name?: string) => (name === "s" ? rt : undefined) }, hub, () => async () => []);
    const settle = () => new Promise((r) => setTimeout(r, 5));

    agents = [blocked("p")];
    hub.publish({ session: "s", topic: "snapshot" });
    await settle();
    expect(interactions.current("s", "p")?.kind).toBe("permission");

    agents = [blocked("p", "claude", "working")];
    hub.publish({ session: "s", topic: "snapshot" });
    await settle();
    expect(interactions.current("s", "p")).toBeNull();

    matched!({ paneId: "p" });
    await settle();
    expect(interactions.current("s", "p")?.kind).toBe("permission");
    expect(published.filter((e) => e.startsWith("interaction:"))).toEqual(["interaction:p", "interaction:p", "interaction:p"]);
  });

  test("a replaced runtime drops the old cards and the old match subscription, and follows the new poker", async () => {
    const hub = new LiveEvents();
    const interactions = new Interactions(hub, { sleep: noSleep });
    const runtime = () => {
      const r = { matched: undefined as ((e: { paneId: string }) => void) | undefined, off: 0 };
      const pane = scriptedPane(fixture("claude--permission-edit.txt"));
      const rt = { name: "s", herdr: pane.io, engine: { current: () => ({ agents: [blocked("p")] }) }, poker: { onOutputMatched: (cb: (e: { paneId: string }) => void) => { r.matched = cb; return () => { r.off++; }; } } };
      return { r, rt };
    };
    const first = runtime();
    let current = first.rt;
    const stop = interactions.follow({ get: (name?: string) => (name === "s" ? current : undefined) }, hub, () => async () => []);
    const settle = () => new Promise((r) => setTimeout(r, 5));
    hub.publish({ session: "s", topic: "snapshot" });
    await settle();
    expect(interactions.current("s", "p")?.kind).toBe("permission");

    const second = runtime();
    current = second.rt;
    hub.publish({ session: "s", topic: "pane", paneId: "other" });
    await settle();
    expect(first.r.off).toBe(1);
    expect(interactions.current("s", "p")).toBeNull();
    expect(second.r.matched).toBeDefined();

    stop();
    expect(second.r.off).toBe(1);
  });
});

describe("Interactions.answer", () => {
  async function ready(file: string, screens: Record<string, string> = {}, agent = agentOf(file)) {
    const { events, live } = recorder();
    const interactions = new Interactions(live, { sleep: noSleep });
    const pane = scriptedPane(fixture(file), screens);
    const [card] = await interactions.refresh("s", pane.io, [blocked("p", agent)]);
    pane.log.reads = 0;
    return { interactions, pane, card: card!, events, answer: (body: Parameters<Interactions["answer"]>[3]) => interactions.answer("s", pane.io, blocked("p", agent), body) };
  }

  test("one read, then exactly the option's keys", async () => {
    const { pane, card, answer, interactions } = await ready("claude--permission-edit.txt");
    const result = await answer({ signature: card.signature, optionIndex: 0 });
    expect(result).toEqual({ status: 200, outcome: { ok: true }, keys: ["1"] });
    expect(pane.log).toEqual({ reads: 1, keys: [["1"]], text: [] });
    expect(interactions.current("s", "p")).toBeNull();
  });

  test("a stale signature is refused before any key", async () => {
    const { pane, card, answer } = await ready("claude--permission-edit.txt");
    pane.show(fixture("claude--permission-bash.txt"));
    const result = await answer({ signature: card.signature, optionIndex: 0 });
    expect(result.status).toBe(409);
    expect(result.outcome).toMatchObject({ ok: false, code: "interaction_changed" });
    expect(pane.log.keys).toEqual([]);
  });

  test("a persistent option needs confirm", async () => {
    const { pane, card, answer } = await ready("claude--permission-edit.txt");
    const always = card.options.find((o) => o.role === "persistent")!;
    expect((await answer({ signature: card.signature, optionIndex: always.index })).outcome).toMatchObject({ code: "confirm_required" });
    expect(pane.log.keys).toEqual([]);
    expect((await answer({ signature: card.signature, optionIndex: always.index, confirm: true })).keys).toEqual(["2"]);
  });

  test("an unknown option is a 400", async () => {
    const { card, answer } = await ready("claude--permission-edit.txt");
    expect((await answer({ signature: card.signature, optionIndex: 9 })).status).toBe(400);
  });

  test("multi-select Submit walks the pointer onto the advance row, then Enter", async () => {
    const { pane, card, answer } = await ready("claude--wizard-multiselect-checked.txt", { Down: fixture("claude--wizard-multiselect-pointer-next.txt") });
    const next = card.options.find((o) => o.label === "Next")!;
    const result = await answer({ signature: card.signature, optionIndex: next.index });
    expect(result.outcome).toEqual({ ok: true });
    expect(pane.log.keys).toEqual([["Down"], ["Enter"]]);
  });

  test("multi-select toggles carry the checkbox state", async () => {
    const { card } = await ready("claude--wizard-multiselect-checked.txt");
    expect(card.options.slice(0, 4).map((o) => o.checked)).toEqual([true, false, true, false]);
  });

  test("plan feedback: focus, type, verify, Enter", async () => {
    const typed = "use a guard clause instead";
    const { pane, card, answer } = await ready("claude--plan-approval--three-row.txt", {
      "3": fixture("claude--plan-approval--three-row-focused.txt"),
      [`text:${typed}`]: fixture("claude--plan-approval--three-row-typed-focused.txt"),
    });
    const change = card.options.find((o) => o.role === "freeText")!;
    const result = await answer({ signature: card.signature, optionIndex: change.index, text: `  ${typed}\n` });
    expect(result.outcome).toEqual({ ok: true });
    expect(pane.log.keys).toEqual([["3"], ["Enter"]]);
    expect(pane.log.text).toEqual([typed]);
  });

  test("plan feedback never types into a focused box, and digits are refused while it has focus", async () => {
    const { pane, card, answer } = await ready("claude--plan-approval--three-row-focused.txt");
    const change = card.options.find((o) => o.role === "freeText")!;
    expect((await answer({ signature: card.signature, optionIndex: change.index, text: "x" })).status).toBe(409);
    expect((await answer({ signature: card.signature, optionIndex: 0, confirm: true })).status).toBe(409);
    expect(pane.log.keys).toEqual([]);
  });

  test("a preview question whose note is being typed is refused before any key", async () => {
    const { pane, card, answer } = await ready("claude--select-preview-note-input.txt");
    const result = await answer({ signature: card.signature, optionIndex: 1 });
    expect(result.outcome).toMatchObject({ ok: false, code: "interaction_changed" });
    expect(pane.log.keys).toEqual([]);
  });

  test("feedback that never lands sends no Enter", async () => {
    const { pane, card, answer } = await ready("claude--plan-approval--three-row.txt", { "3": fixture("claude--plan-approval--three-row-focused.txt") });
    const change = card.options.find((o) => o.role === "freeText")!;
    const result = await answer({ signature: card.signature, optionIndex: change.index, text: "something else" });
    expect(result.outcome.ok).toBe(false);
    expect(pane.log.keys).toEqual([["3"]]);
  });
});

describe("parseAnswer", () => {
  test("accepts a well-formed body and rejects the rest", () => {
    expect(parseAnswer({ signature: "abc", optionIndex: 1 })).toEqual({ signature: "abc", optionIndex: 1 });
    expect(parseAnswer({ signature: "abc", optionIndex: 1, confirm: true, text: "t" })).toEqual({ signature: "abc", optionIndex: 1, confirm: true, text: "t" });
    for (const bad of [null, {}, { signature: "", optionIndex: 0 }, { signature: "a", optionIndex: -1 }, { signature: "a", optionIndex: 1.5 }, { signature: "a", optionIndex: 0, confirm: "yes" }, { signature: "x".repeat(65), optionIndex: 0 }]) {
      expect(parseAnswer(bad)).toBeNull();
    }
  });
});

// Over real HTTP: the gates, the ETag and the one-request answer, against a fake Herdr.
describe("the interactions routes", () => {
  let url = "";
  let dispose = async () => {};
  const herdrLog = { reads: 0, keys: [] as string[][] };
  let screen = fixture("claude--permission-edit.txt");
  let lookup: InteractionLookup = () => null;
  const live = new LiveEvents();

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "nenu-interactions-"));
    const paneInfo = { pane_id: "w:p", terminal_id: "t", workspace_id: "w", tab_id: "tab", focused: false, cwd: dir, agent: "claude", agent_status: "blocked" as const, revision: 0 };
    const herdr = {
      async sessionSnapshot() { return { version: "test", protocol: 16, workspaces: [], panes: [paneInfo], tabs: [] }; },
      async listPanes() { return [paneInfo]; },
      async readPane(_id: string, source: string) {
        if (source === "recent") herdrLog.reads++;
        return { pane_id: "w:p", text: screen, truncated: false, revision: 0 };
      },
      async sendPaneKeys(_id: string, keys: string[]) { herdrLog.keys.push(keys); },
      async sendPaneText() {},
    };
    const engine = new StateEngine(herdr as unknown as HerdrClient, 60_000);
    engine.start();
    await new Promise<void>((resolve) => engine.onUpdate(() => resolve()));
    const runtime = { name: "default", isPrimary: true, engine, herdr, socketPath: join(dir, "herdr.sock") };
    const cfg = {
      ...loadConfig(), host: "127.0.0.1", port: 0, stateDir: dir, transcript: false,
      trustedUser: "", skipServe: true, allowAnyHost: false, publicHosts: ["nenu.example"],
      tailscaleHosts: [], allowedOrigins: [], deviceHeader: "x-device", deviceAllowlist: ["phone"],
    };
    const server = startServer({
      cfg,
      registry: { get: (name?: string) => (!name || name === "default" ? runtime : undefined), list: () => [], all: () => [runtime] },
      push: { enabled: false, publicKey: "", useInteractions: (fn: InteractionLookup) => void (lookup = fn) }, snooze: { until: () => null }, notifyPrefs: { current: () => ({}) },
      updateMonitor: { status: () => ({}), checkRelease: async () => {} },
      audit: { record: () => {} },
      activity: { get: () => undefined, noteSeen: () => {} },
      live,
    } as unknown as Parameters<typeof startServer>[0]);
    url = `http://127.0.0.1:${server.port}`;
    dispose = async () => {
      engine.stop();
      await server.stop(true);
      await rm(dir, { recursive: true, force: true });
    };
  });

  afterAll(() => dispose());

  const phone = () => ({ origin: url, "x-device": "phone", "content-type": "application/json" });
  const list = (headers: Record<string, string> = {}) => fetch(`${url}/api/interactions`, { headers });
  const answer = (body: unknown, headers: Record<string, string> = phone()) =>
    fetch(`${url}/api/interactions/w%3Ap/answer`, { method: "POST", headers, body: JSON.stringify(body) });

  test("GET lists the blocked pane's card with an ETag, and 304s while it is unchanged", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const { interactions } = (await res.json()) as { interactions: DetectedInteraction[] };
    expect(interactions.map((i) => [i.paneId, i.kind, i.question])).toEqual([["w:p", "permission", "Do you want to create hello.txt?"]]);
    const etag = res.headers.get("etag")!;
    expect((await list({ "if-none-match": etag })).status).toBe(304);
  });

  test("a read-only device and a foreign origin cannot answer", async () => {
    expect((await answer({ signature: "x", optionIndex: 0 }, { origin: url, "x-device": "tablet" })).status).toBe(403);
    expect((await answer({ signature: "x", optionIndex: 0 }, { origin: "http://evil.example", "x-device": "phone" })).status).toBe(403);
    expect(herdrLog.keys).toEqual([]);
  });

  test("a stale signature is a 409 with no keys; a fresh one answers in one request", async () => {
    const { interactions } = (await (await list()).json()) as { interactions: DetectedInteraction[] };
    herdrLog.reads = 0;
    const stale = await answer({ signature: "stale", optionIndex: 0 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, code: "interaction_changed" });
    expect(herdrLog.keys).toEqual([]);

    herdrLog.reads = 0;
    const res = await answer({ signature: interactions[0]!.signature, optionIndex: 0 });
    expect(await res.json()).toEqual({ ok: true });
    expect(herdrLog).toEqual({ reads: 1, keys: [["1"]] });
  });

  test("an agent alert's lookup reads the pane and finds its dialog before any client asked", async () => {
    herdrLog.reads = 0;
    expect((await lookup(undefined, "w:p"))?.question).toBe("Do you want to create hello.txt?");
    expect(herdrLog.reads).toBe(1);
    expect(await lookup("elsewhere", "w:p")).toBeNull();
  });

  test("a herd change re-detects and publishes the card without a GET", async () => {
    const heard: string[] = [];
    const off = live.subscribe((e) => void heard.push(`${e.topic}:${e.paneId ?? ""}`));
    screen = fixture("claude--permission-bash.txt");
    live.publish({ session: "default", topic: "snapshot" });
    for (let i = 0; i < 50 && !heard.includes("interaction:w:p"); i++) await new Promise((r) => setTimeout(r, 5));
    off();
    screen = fixture("claude--permission-edit.txt");
    expect(heard).toContain("interaction:w:p");
  });

  test("bad bodies and unknown panes", async () => {
    expect((await answer({ optionIndex: 0 })).status).toBe(400);
    const res = await fetch(`${url}/api/interactions/w%3Anope/answer`, { method: "POST", headers: phone(), body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("free-text rows", () => {
  test("a 'Type something' row is typed in the terminal, never answered by its key", () => {
    // Claude's grammar already leaves the row out; another harness's menu may not.
    const dialog = { kind: "menu" as const, model: { title: "Pick", actions: [{ label: "Type something", keys: ["t"] }, { label: "Ok", keys: ["Enter"] }], nav: { upDown: false }, signature: "Pick" } };
    const { interaction, choices } = toInteraction({ paneId: "p", agent: "x" }, dialog, 0, [], 0);
    expect(interaction.options.map((o) => o.role)).toEqual(["freeText", "neutral"]);
    expect(choices.map((c) => c.recipe.type)).toEqual(["unsupported", "keys"]);
  });
});

describe("free-text answers (Tab-amend, Type something, Codex notes)", () => {
  const P0_CLAUDE = join(ROOT, "web/src/lib/harness/claude/fixtures");
  const P0_CODEX = join(ROOT, "web/src/lib/harness/codex/fixtures");
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  /** `screen` with `❯` (or Codex's `›`) moved onto the numbered menu row `n`. */
  function pointAt(screen: string, n: number, glyph = "❯"): string {
    return screen.split("\n").map((l) => {
      const bare = l.replace(new RegExp(`^(\\s*)${glyph} (?=\\d+\\. )`), "$1  ");
      return new RegExp(`^\\s*${n}\\. `).test(bare) ? bare.replace(/^(\s*)  (?=\d)/, `$1${glyph} `) : bare;
    }).join("\n");
  }

  /** A pane that walks through `steps` in order: each key or `text:` write shows the next screen. */
  function sequencePane(initial: string, steps: Array<[string, string]>) {
    let screen = initial;
    const queue = [...steps];
    const log = { keys: [] as string[][], text: [] as string[] };
    const advance = (trigger: string) => {
      if (queue[0]?.[0] === trigger) screen = queue.shift()![1];
    };
    const io: PaneIO = {
      async readPane(): Promise<PaneRead> { return { pane_id: "p", text: screen, truncated: false, revision: 0 }; },
      async sendPaneKeys(_pane, keys) { log.keys.push(keys); for (const k of keys) advance(k); },
      async sendPaneText(_pane, text) { log.text.push(text); advance(`text:${text}`); },
    };
    return { io, log };
  }

  async function card(io: PaneIO, agent = "claude") {
    const interactions = new Interactions({ publish() {} }, { sleep: noSleep });
    const [found] = await interactions.refresh("s", io, [blocked("p", agent)]);
    return { card: found!, answer: (body: Parameters<Interactions["answer"]>[3]) => interactions.answer("s", io, blocked("p", agent), body) };
  }

  const claude = (name: string) => fixture(name, P0_CLAUDE);
  const bash = claude("permission-bash-v2296.txt");

  test("only measured rows accept text, and a text answer to another option is a 400", async () => {
    const pane = sequencePane(bash, []);
    const { card: c, answer } = await card(pane.io);
    expect(c.options.map((o) => o.acceptsText ?? false)).toEqual([true, false, false, true]);
    const result = await answer({ signature: c.signature, optionIndex: 1, text: "x", confirm: true });
    expect(result.status).toBe(400);
    expect(pane.log.keys).toEqual([]);
  });

  test("text over the limit is refused before any key, never cut to a string the field cannot echo", async () => {
    const pane = sequencePane(bash, []);
    const { card: c, answer } = await card(pane.io);
    const result = await answer({ signature: c.signature, optionIndex: 0, text: `${"a".repeat(239)} bc` });
    expect(result.status).toBe(400);
    expect(pane.log.keys).toEqual([]);
    expect(pane.log.text).toEqual([]);
  });

  test("Yes without text is still the digit alone", async () => {
    const pane = sequencePane(bash, []);
    const { card: c, answer } = await card(pane.io);
    expect((await answer({ signature: c.signature, optionIndex: 0 })).keys).toEqual(["1"]);
  });

  test("Yes with text: Tab, type, read back, Enter (captured 2.1.296 screens)", async () => {
    const typed = "use printf instead of echo";
    const pane = sequencePane(bash, [["Tab", claude("permission-bash-amend-v2296.txt")], [`text:${typed}`, claude("permission-bash-amend-typed-v2296.txt")]]);
    const { card: c, answer } = await card(pane.io);
    const result = await answer({ signature: c.signature, optionIndex: 0, text: ` ${typed}\n` });
    expect(result).toEqual({ status: 200, outcome: { ok: true }, keys: ["Tab", "Enter"] });
    expect(pane.log.text).toEqual([typed]);
  });

  test("No with text walks the pointer down one verified row at a time, through the rows that drop the Tab hint", async () => {
    const base = plain(bash);
    const at = (n: number, footer = "Esc to cancel") => pointAt(base, n).replace("Esc to cancel · Tab to amend", footer);
    const open = (label: string) => at(4).replace(/❯ 4\. No$/m, `❯ 4. ${label}`);
    const typed = "keep the file";
    const pane = sequencePane(base, [
      ["Down", at(2)],
      ["Down", at(3)],
      ["Down", at(4, "Esc to cancel · Tab to amend")],
      ["Tab", open("No, and tell Claude what to do differently")],
      [`text:${typed}`, open(`No, ${typed}`)],
    ]);
    const { card: c, answer } = await card(pane.io);
    const result = await answer({ signature: c.signature, optionIndex: 3, text: typed });
    expect(result.outcome).toEqual({ ok: true });
    expect(pane.log.keys).toEqual([["Down"], ["Down"], ["Down"], ["Tab"], ["Enter"]]);
  });

  test("text that never shows up in the field sends no Enter", async () => {
    const pane = sequencePane(bash, [["Tab", claude("permission-bash-amend-v2296.txt")]]);
    const { card: c, answer } = await card(pane.io);
    const result = await answer({ signature: c.signature, optionIndex: 0, text: "something else" });
    expect(result.outcome.ok).toBe(false);
    expect(pane.log.keys).toEqual([["Tab"]]);
  });

  test("an amend field already open is someone typing: nothing is sent", async () => {
    const pane = sequencePane(claude("permission-bash-amend-typed-v2296.txt"), []);
    const { card: c, answer } = await card(pane.io);
    expect(c.typing).toBe(true);
    expect((await answer({ signature: c.signature, optionIndex: 0, confirm: true })).status).toBe(409);
    expect(pane.log).toEqual({ keys: [], text: [] });
  });

  test("Type something: walk onto the empty row, type, verify, step Up off it; nothing is submitted", async () => {
    const base = plain(claude("ask-multiselect-v2296.txt"));
    const filled = (n: number) => pointAt(base, n).replace("4. [ ] Type something", "4. [✔] Mango");
    const pane = sequencePane(base, [
      ["Down", pointAt(base, 2)],
      ["Down", pointAt(base, 3)],
      ["Down", pointAt(base, 4)],
      ["text:Mango", filled(4)],
      ["Up", filled(3)],
    ]);
    const { card: c, answer } = await card(pane.io);
    const row = c.options.find((o) => o.label === "Type something")!;
    expect(row).toMatchObject({ role: "freeText", acceptsText: true });
    const result = await answer({ signature: c.signature, optionIndex: row.index, text: "Mango" });
    expect(result).toEqual({ status: 200, outcome: { ok: true }, keys: ["Down", "Down", "Down", "Up"] });
    expect(pane.log.text).toEqual(["Mango"]);
  });

  test("a filled Type something row is an ordinary option; the pointer on the empty row locks the card", () => {
    const filled = toInteraction({ paneId: "p", agent: "claude" }, dialogOnScreen("claude", claude("ask-type-something-filled-v2296.txt"))!, 0, [], 0).interaction;
    expect(filled.options.some((o) => o.acceptsText)).toBe(false);
    const focused = toInteraction({ paneId: "p", agent: "claude" }, dialogOnScreen("claude", claude("ask-type-something-focused-v2296.txt"))!, 0, [], 0).interaction;
    expect(focused.typing).toBe(true);
  });

  test("a single-choice 'Type something.' is shown but answered in the terminal", async () => {
    const pane = sequencePane(fixture("claude--select-menu.txt"), []);
    const { card: c, answer } = await card(pane.io);
    const row = c.options.find((o) => o.role === "freeText")!;
    expect(row.acceptsText).toBeUndefined();
    expect((await answer({ signature: c.signature, optionIndex: row.index })).outcome).toMatchObject({ code: "unsupported" });
    expect(pane.log.keys).toEqual([]);
  });

  test("Codex notes: walk to None of the above, Tab, type, read back, Enter (captured 0.160.1 screens)", async () => {
    const codex = (name: string) => fixture(name, P0_CODEX);
    const start = pointAt(plain(codex("ask-notes-row-pointed-v0160.txt")), 1, "›");
    const pane = sequencePane(start, [
      ["Down", pointAt(start, 2, "›")],
      ["Down", codex("ask-notes-row-pointed-v0160.txt")],
      ["Tab", codex("ask-notes-open-v0160.txt")],
      ["text:Mango please", codex("ask-notes-typed-v0160.txt")],
    ]);
    const { card: c, answer } = await card(pane.io, "codex");
    expect(c.options.map((o) => o.acceptsText ?? false)).toEqual([false, false, true]);
    const result = await answer({ signature: c.signature, optionIndex: 2, text: "Mango please" });
    expect(result).toEqual({ status: 200, outcome: { ok: true }, keys: ["Down", "Down", "Tab", "Enter"] });
  });
});
