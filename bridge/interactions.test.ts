import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import type { HerdrClient, PaneRead } from "./herdr-client.ts";
import type { InteractionLookup } from "./push.ts";
import { dialogOnScreen, Interactions, pushActions, toInteraction, type PaneIO } from "./interactions.ts";
import { LiveEvents } from "./live-events.ts";
import { parseAnswer } from "./routes/interactions.ts";
import { startServer } from "./server.ts";
import { StateEngine } from "./state-engine.ts";
import type { AgentView, Interaction, InteractionHint, LiveEvent } from "./types.ts";

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
  "claude--permission-edit.txt": "permission: Yes=primary | Yes, allow all edits during this session=persistent | No=deny",
  "claude--plan-approval--feedback-focused.txt": "plan: Yes, clear context (5% used) and use auto mode=persistent | Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval--feedback-typed.txt": "plan: Yes, clear context (4% used) and use auto mode=persistent | Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval--feedback-wrapped.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval--numbered-body.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | No, refine with Ultraplan on Claude Code on the web=deny | Tell Claude what to change=freeText",
  "claude--plan-approval--three-row-focused.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval--three-row-typed-focused.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval--three-row.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  "claude--plan-approval.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | No, refine with Ultraplan on Claude Code on the web=deny | Tell Claude what to change=freeText",
  "claude--select-menu.txt": "question: Red=neutral | Green=neutral | Blue=neutral | Chat about this=deny | Type something.=freeText",
  "claude--select-multi.txt": "wizard: Plan first=neutral | Just build it=neutral | Build + verify=neutral | Chat about this=deny | Back=nav | Next=nav",
  "claude--select-multiselect-checked.txt": "multi-select: Cheese=neutral | Mushrooms=neutral | Olives=neutral | Peppers=neutral | Type something=freeText | Submit=primary | Chat about this=deny",
  "claude--select-multiselect-review.txt": "multi-select: Submit answers=primary | Cancel=deny",
  "claude--select-multiselect-single.txt": "multi-select: Cheese=neutral | Mushrooms=neutral | Olives=neutral | Peppers=neutral | Type something=freeText | Submit=primary | Chat about this=deny",
  "claude--select-preview-note-attached.txt": "question: Boxy=neutral | Rounded=neutral | Minimal=neutral",
  "claude--select-preview-note-input.txt": "question: Boxy=neutral | Rounded=neutral | Minimal=neutral",
  "claude--select-preview.txt": "question: Boxy=neutral | Rounded=neutral | Minimal=neutral",
  "claude--trust-prompt.txt": "permission: Yes, I trust this folder=persistent | No, exit=deny",
  "claude--v2285-ask-multi.txt": "multi-select: Apple=neutral | Banana=neutral | Cherry=neutral | Type something=freeText | Submit=primary | Chat about this=deny",
  "claude--v2285-ask-question.txt": "question: Apple=neutral | Banana=neutral | Chat about this=deny | Type something.=freeText",
  "claude--v2285-ask-wizard.txt": "wizard: Apple=neutral | Banana=neutral | Chat about this=deny | Next=nav",
  "claude--wizard-multiselect-checked.txt": "multi-select: Pepperoni=neutral | Mushrooms=neutral | Bell peppers=neutral | Extra cheese=neutral | Next=primary | Chat about this=deny",
  "claude--wizard-multiselect-final.txt": "multi-select: Garlic knots=neutral | Caesar salad=neutral | Dipping sauces=neutral | Submit=primary | Chat about this=deny",
  "claude--wizard-multiselect-pointer-next.txt": "multi-select: Pepperoni=neutral | Mushrooms=neutral | Bell peppers=neutral | Extra cheese=neutral | Next=primary | Chat about this=deny",
  "claude--wizard-multiselect-q1.txt": "multi-select: Pepperoni=neutral | Mushrooms=neutral | Bell peppers=neutral | Extra cheese=neutral | Next=primary | Chat about this=deny",
  "claude--wizard-preview-note-attached.txt": "question: Grid=neutral | List=neutral",
  "claude--wizard-preview-q1.txt": "question: Grid=neutral | List=neutral",
  "claude--wizard-preview-wrapped-label.txt": "question: Grid of equal-width cards with a fixed gutter (Recommended)=neutral | List=neutral",
  "claude--wizard-q1-revisit.txt": "wizard: Parser=neutral | UI=neutral | Tests=neutral | Chat about this=deny | Next=nav",
  "claude--wizard-q1.txt": "wizard: Parser=neutral | UI=neutral | Tests=neutral | Chat about this=deny | Next=nav",
  "claude--wizard-q2.txt": "wizard: Small=neutral | Medium=neutral | Large=neutral | Chat about this=deny | Back=nav | Next=nav",
  "claude--wizard-submit-unanswered.txt": "wizard: Submit answers=primary | Cancel=deny | Back=nav",
  "claude--wizard-submit.txt": "wizard: Submit answers=primary | Cancel=deny | Back=nav",
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
  "codex--ask-notes-focused.txt": "question: Tabs (Recommended)=neutral | Spaces=neutral | None of the above=neutral",
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
  // The Rewind a second Escape opens at an idle Claude (ADR 0066): its footer names Enter and Esc.
  "interrupt-rewind-v2296.txt": "menu: Continue=neutral | Cancel=deny",
  "permission-auto-deny-a-v2299.txt": "permission: Yes=primary | No=deny",
  "permission-auto-deny-b-v2299.txt": "permission: Yes=primary | No=deny",
  "permission-bash-v2296.txt": "permission: Yes=primary | Yes, and always allow access to /private/tmp/claude-501/nenu-probe from this project=persistent | Yes, and switch to auto mode · auto mode handles these prompts for you=persistent | No=deny",
  "permission-bash-amend-typed-v2296.txt": "permission: Yes, and always allow access to /private/tmp/claude-501/nenu-probe from this project=persistent | Yes, and switch to auto mode · auto mode handles these prompts for you=persistent | No=deny",
  "permission-bash-amend-v2296.txt": "permission: Yes, and always allow access to /private/tmp/claude-501/nenu-probe from this project=persistent | Yes, and switch to auto mode · auto mode handles these prompts for you=persistent | No=deny",
  "permission-deny-amend-typed-v2296.txt": "permission: Yes=primary | Yes, and always allow access to /private/tmp/claude-501/nenu-probe from this project=persistent | Yes, and switch to auto mode · auto mode handles these prompts for you=persistent",
  "permission-pointer-mid-v2296.txt": "permission: Yes=primary | Yes, and always allow access to=persistent | Yes, and switch to auto mode · auto mode handles these prompts for you=persistent | No=deny",
  "plan-approval-v2296.txt": "plan: Yes, and use auto mode=persistent | Yes, manually approve edits=primary | Tell Claude what to change=freeText",
  // 2.1.296 drew the folder-trust prompt without numbers, "No, exit" first under the cursor.
  "trust-prompt-v2296.txt": "permission: No, exit=deny | Yes, I trust this folder=persistent",
  // web/src/lib/harness/codex/fixtures
  "approval-exec-v0160.txt": "permission: Yes, proceed=primary | No, and tell Codex what to do differently=deny",
  "hooks-review-v0162.txt": "permission: Review hooks=persistent | Trust all and continue=persistent | Continue without trusting (hooks won't run)=deny",
  "ask-notes-open-v0160.txt": "question: Apple=neutral | Banana=neutral | None of the above=neutral",
  "ask-notes-row-pointed-v0160.txt": "question: Apple=neutral | Banana=neutral | None of the above=neutral",
  "ask-notes-typed-v0160.txt": "question: Apple=neutral | Banana=neutral | None of the above=neutral",
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

function detect(file: string, hints: InteractionHint[] = [], agent = agentOf(file), above = ""): Interaction {
  const text = above + fixture(file);
  return toInteraction({ paneId: "p", agent }, dialogOnScreen(agent, text)!, 0, hints, 0).interaction;
}

describe("where a question sits in its set", () => {
  test("a single AskUserQuestion's header chip names it instead of filling the detail", () => {
    const i = detect("claude--v2285-ask-question.txt");
    expect(i.steps).toEqual([{ label: "Fruit", answered: false, current: true }]);
    expect(i.context).toBeUndefined();
  });

  test("a multi-question wizard carries its stepper, the current step marked", () => {
    const i = detect("claude--wizard-q2.txt");
    expect(i.steps).toEqual([
      { label: "Focus area", answered: true, current: false },
      { label: "Scope", answered: false, current: true },
      { label: "Workflow", answered: false, current: false },
    ]);
  });

  test("a wizard read without its colours marks the first unanswered question as the one on screen", () => {
    const i = detect("claude--wizard-q2.txt");
    const plain = toInteraction({ paneId: "p", agent: "claude" }, dialogOnScreen("claude", fixture("claude--wizard-q2.txt").replace(/\x1b\[[0-9;]*m/g, ""))!, 0, [], 0).interaction;
    expect(plain.steps?.find((s) => s.current)?.label).toBe("Scope");
    expect(i.steps?.find((s) => s.current)?.label).toBe("Scope");
  });

  test("a wizard's review serves its answers and marks no question as on screen", () => {
    const i = detect("claude--wizard-submit.txt");
    expect(i.answers).toEqual([
      { question: "Which focus area should we work on?", answer: "UI" },
      { question: "What scope should this work have?", answer: "Medium" },
      { question: "How should we approach the work?", answer: "Plan first" },
    ]);
    expect(i.steps?.some((s) => s.current)).toBe(false);
    const unanswered = detect("claude--wizard-submit-unanswered.txt");
    expect(unanswered.steps?.some((s) => s.current)).toBe(false);
  });

  test("a review with a question left unanswered says so", () => {
    expect(detect("claude--wizard-submit-unanswered.txt").incomplete).toBe(true);
    expect(detect("claude--select-multiselect-review.txt").incomplete).toBe(true);
    expect(detect("claude--wizard-submit.txt").incomplete).toBeUndefined();
  });

  test("a multi-select review serves what Submit sends", () => {
    const screen = fixture("ask-review-v2296.txt", join(ROOT, "web/src/lib/harness/claude/fixtures"));
    const i = toInteraction({ paneId: "p", agent: "claude" }, dialogOnScreen("claude", screen)!, 0, [], 0).interaction;
    expect(i.answers).toEqual([{ question: "Which fruits do you like?", answer: "Apple, Mango" }]);
  });

  test("Codex's 'Question 1/2' header becomes the steps, never the detail", () => {
    const q1 = detect("codex--ask-wizard-q1.txt");
    expect(q1.steps).toEqual([{ label: "Question 1", answered: false, current: true }, { label: "Question 2", answered: false, current: false }]);
    expect(q1.context).toBeUndefined();
    // "Question 2/2 (1 unanswered)" says how many, not which: question 1 may be the one skipped.
    expect(detect("codex--ask-wizard-q2.txt").steps).toEqual([{ label: "Question 1", answered: false, current: false }, { label: "Question 2", answered: false, current: true }]);
    const single = detect("codex--ask-fruit.txt");
    expect(single.steps).toBeUndefined();
    expect(single.context).toBeUndefined();
  });

  test("a permission keeps its subject and has no steps", () => {
    const i = detect("claude--permission-bash.txt");
    expect(i.steps).toBeUndefined();
    expect(i.context).toContain("mkfifo fixture-fifo");
  });
});

describe("what a permission asks for, as the dialog draws it", () => {
  const CLAUDE_P0 = join(ROOT, "web/src/lib/harness/claude/fixtures");
  const at = (file: string, dir: string, agent: string, hints: InteractionHint[] = []) =>
    toInteraction({ paneId: "p", agent }, dialogOnScreen(agent, fixture(file, dir))!, 0, hints, 0).interaction;

  test("Claude 2.1.296: tool, description and command apart, without the Tip row", () => {
    const i = at("permission-bash-v2296.txt", CLAUDE_P0, "claude");
    expect(i.subject).toEqual({ tool: "Bash", description: "Write hi into hello.txt in the project directory", command: "echo hi > hello.txt" });
    expect(i.context).not.toContain("Tip:");
  });

  test("an older Claude: the command above its description, without 'This command requires approval'", () => {
    const i = detect("claude--permission-bash.txt");
    expect(i.subject).toEqual({ tool: "Bash", command: "mkfifo fixture-fifo", description: "Create a named pipe (FIFO)" });
    expect(i.context).not.toContain("requires approval");
  });

  test("a narrow pane: the wrapped Tip is dropped and the command's wrapped rows join up", () => {
    const i = detect("claude-lab--permission-bash--w40.txt", [], "claude");
    expect(i.subject).toEqual({ tool: "Bash", command: "touch /tmp/claude-lab/project/scratch-one.txt", description: "Create empty file scratch-one.txt" });
    expect(i.context).not.toMatch(/Tip:|below/);
  });

  test("a file the call writes, with its preview lines and their numbers", () => {
    expect(detect("claude--permission-edit.txt").subject).toEqual({ tool: "Create file", file: "hello.txt", preview: "1 hello" });
    expect(detect("claude-lab--permission-write--w82.txt", [], "claude").subject).toEqual({
      tool: "Create file", file: "docs/lab-notes.md",
      preview: "1 # Lab Notes\n2\n3 This is a throwaway project used for screen captures.\n4 It has no real application code, only sample files.\n5 Changes here are safe to discard at any time.",
    });
  });

  test("a command taller than the old twelve-row window keeps its tool, description and every row", () => {
    const rows = ["cat > notes.md <<'EOF'", ...Array.from({ length: 10 }, (_, n) => `- note ${n + 1}`), "EOF"];
    const plain = fixture("permission-bash-v2296.txt", CLAUDE_P0).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    const screen = plain.replace(/^ echo hi > hello\.txt *$/m, rows.map((r) => ` ${r}`).join("\n"));
    expect(screen).toContain(" - note 10\n");
    const hint: InteractionHint = { source: "claude-hook", observedAt: 1, question: "Bash", detail: rows.join("\n") };
    const i = toInteraction({ paneId: "p", agent: "claude" }, dialogOnScreen("claude", screen)!, 0, [hint], 0).interaction;
    expect(i.subject).toEqual({ tool: "Bash", description: "Write hi into hello.txt in the project directory", command: rows.join("\n") });
    expect(i.detailComplete).toBe(true);
  });

  test("an agreeing hook hint gives the exact command", () => {
    const command = "touch /tmp/claude-lab/project/scratch-one.txt";
    const i = detect("claude-lab--permission-bash--w40.txt", [{ source: "claude-hook", observedAt: 1, question: "Bash", detail: command }], "claude");
    expect(i.subject?.command).toBe(command);
    expect(i.detailComplete).toBe(true);
  });

  test("an indented command wrapped onto its last row keeps that row: a full row above it is no description's", () => {
    const command = "touch /tmp/claude-lab/project/scratch-one.txt";
    const screen = fixture("claude-lab--permission-bash--w40.txt").replace(/^[^\n]*Create empty file scratch-one\.txt[^\n]*\n/m, "");
    const plain = toInteraction({ paneId: "p", agent: "claude" }, dialogOnScreen("claude", screen)!, 0, [], 0).interaction;
    expect(plain.subject).toEqual({ tool: "Bash", command });
    const hinted = toInteraction({ paneId: "p", agent: "claude" }, dialogOnScreen("claude", screen)!, 0, [{ source: "claude-hook", observedAt: 1, question: "Bash", detail: command }], 0).interaction;
    expect(hinted.subject).toEqual({ tool: "Bash", command });
    expect(hinted.detailComplete).toBe(true);
  });

  test("an agreeing hint says where an indented command ends, so its second line is never read as the description", () => {
    const command = "mkfifo fixture-fifo\nls -la fixture-fifo";
    const screen = fixture("claude--permission-bash.txt").replace("Create a named pipe (FIFO)", "ls -la fixture-fifo");
    const i = toInteraction({ paneId: "p", agent: "claude" }, dialogOnScreen("claude", screen)!, 0, [{ source: "claude-hook", observedAt: 1, question: "Bash", detail: command }], 0).interaction;
    expect(i.subject).toEqual({ tool: "Bash", command });
    expect(i.detailComplete).toBe(true);
  });

  test("a hint the card's command does not spell never makes the card whole", () => {
    // The hint is a row of the dialog, but the description's row, not the command's.
    const i = detect("claude--permission-bash.txt", [{ source: "claude-hook", observedAt: 1, question: "Bash", detail: "Create a named pipe (FIFO)" }]);
    expect(i.subject).toEqual({ tool: "Bash", command: "mkfifo fixture-fifo", description: "Create a named pipe (FIFO)" });
    expect(i.detailComplete).toBe(false);
    expect(pushActions(i)).toEqual([]);
  });

  test("Codex: the reason as the description, the $ row as the command, the environment as a fact", () => {
    expect(detect("codex--approval-exec.txt").subject).toEqual({
      description: "Do you want to allow creating /tmp/collie-codex-probe.txt outside the sandbox?",
      command: "touch /tmp/collie-codex-probe.txt",
      meta: ["Environment: local"],
    });
    expect(detect("codex--v0156-approval-patch.txt").subject).toEqual({ description: "Apply proposed file edits", file: "/tmp/collie-codex-debug/hello.py" });
  });

  test("Codex: a word-wrapped command and reason join with a space, a heredoc keeps its lines", () => {
    expect(detect("codex--v0156-approval-exec-wrapped.txt").subject?.command).toBe(
      'echo "this is a very long line of text that should be long enough to wrap across the terminal width when codex prints the dollar-sign command preview row in the approval dialog box" > longline.txt');
    expect(detect("codex--v0156-approval-exec-wrapped-50.txt").subject?.description).toBe("May I run `touch narrow-approval-test.txt` to create the requested file?");
    expect(detect("codex--v0156-approval-exec-2opt.txt").subject?.command).toBe("cat <<'EOF' > multi.txt\nline one\nline two\nEOF");
  });

  test("Grok: the subject stops at the first option row, so a row that is never a button stays out", () => {
    const i = detect("grok--permission-rm.txt");
    expect(i.context).toBe("rm hello.txt");
    expect(i.subject).toBeUndefined();
  });

  test("the persistent rows Codex and Grok keep to the keyboard are named, never served as options", () => {
    expect(detect("codex--approval-exec.txt").terminalOnly).toEqual(["Yes, and don't ask again for commands that start with `touch /tmp/collie-codex-probe.txt`"]);
    expect(detect("codex--v0156-approval-patch.txt").terminalOnly).toEqual(["Yes, and don't ask again for these files"]);
    expect(detect("codex--v0156-approval-exec-wrapped.txt").terminalOnly).toEqual([
      'Yes, and don\'t ask again for commands that start with `echo "this is a very long line of text that should be long enough to wrap across the terminal width when codex prints the dollar-sign command preview row in the approval dialog box" > longline.txt`',
    ]);
    expect(detect("grok--permission-rm.txt").terminalOnly).toEqual(["Yes, and don't ask again for anything (always-approve mode)"]);
    expect(detect("grok--permission-edit.txt").terminalOnly).toEqual(["Yes, and don't ask again for anything (always-approve mode)", "Yes, allow all edits during this session"]);
    expect(detect("codex--v0156-approval-exec-2opt.txt").terminalOnly).toBeUndefined();
    expect(at("permission-bash-v2296.txt", CLAUDE_P0, "claude").terminalOnly).toBeUndefined();
  });

  test("terminal key hints never reach a label or a description", () => {
    expect(detect("claude--permission-edit.txt").options[1]!.label).toBe("Yes, allow all edits during this session");
    expect(detect("codex--ask-fruit.txt").options[2]!.description).toBe("Optionally, add details in notes.");
  });
});

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

  test("a plan is whole on the card only when its hint agreed with the screen", () => {
    const plan = "## Change\n\nCreate haiku.txt\n\n## Verification\n\n- Confirm the file exists and contains exactly three lines.\n- Read it back to confirm the 5–7–5 structure and dog theme.";
    expect(detect("claude--plan-approval.txt", [{ source: "claude-journal", observedAt: 1, detail: plan }]).detailComplete).toBe(true);
    expect(detect("claude--plan-approval.txt").detailComplete).toBe(false);
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

  test("Codex's notes box with the keyboard is the same question, typing, and answers nothing", () => {
    const i = detect("codex--ask-notes-focused.txt");
    expect(i.kind).toBe("question");
    expect(i.question).toBe("Tabs or spaces?");
    expect(i.typing).toBe(true);
    expect(pushActions(i)).toEqual([]);
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

describe("the unnumbered folder-trust prompt", () => {
  test("trusting walks the cursor down to its row, then Enter; Enter alone would exit", async () => {
    const interactions = new Interactions(recorder().live, { sleep: noSleep });
    const pane = scriptedPane(fixture("trust-prompt-v2296.txt", join(ROOT, "web/src/lib/harness/claude/fixtures")));
    const [card] = await interactions.refresh("s", pane.io, [blocked("p")]);
    const trust = card!.options.find((o) => o.label === "Yes, I trust this folder")!;
    expect(trust.role).toBe("persistent");
    const result = await interactions.answer("s", pane.io, blocked("p"), { signature: card!.signature, optionIndex: trust.index, confirm: true });
    expect(result.keys).toEqual(["Down", "Enter"]);
    expect(pane.log.keys).toEqual([["Down", "Enter"]]);
  });
});

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

  test("a pane Herdr cannot classify is read, so a dialog its manifest misses still gets a card", async () => {
    const interactions = new Interactions(recorder().live, { sleep: noSleep });
    const pane = scriptedPane(fixture("hooks-review-v0162.txt", join(ROOT, "web/src/lib/harness/codex/fixtures")));
    const [card] = await interactions.refresh("s", pane.io, [blocked("p", "codex", "unknown")]);
    expect(card?.question).toBe("Hooks need review");
    // The stakes are on the card before any button: how many hooks, and that they leave the sandbox.
    expect(card?.context).toBe("3 hooks are new or changed.\nHooks can run outside the sandbox after you trust them.");
    const answer = (optionIndex: number, confirm?: true) =>
      interactions.answer("s", pane.io, blocked("p", "codex", "unknown"), { signature: card!.signature, optionIndex, ...(confirm ? { confirm } : {}) });
    expect((await answer(1)).outcome).toMatchObject({ code: "confirm_required" });
    expect(pane.log.keys).toEqual([]);
    expect((await answer(1, true)).keys).toEqual(["Down", "Enter"]);
    expect((await answer(2)).keys).toEqual(["Down", "Down", "Enter"]);
  });

  test("the CLI's own `waiting` makes a pane Herdr still calls working eligible (ADR 0067)", async () => {
    let waiting = false;
    const interactions = new Interactions(recorder().live, { sleep: noSleep, waiting: () => waiting });
    const pane = scriptedPane(fixture("codex--approval-exec.txt"));
    const working = blocked("p", "codex", "working");
    expect(await interactions.refresh("s", pane.io, [working])).toEqual([]);
    waiting = true;
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
    expect(result.outcome).toEqual({ ok: false, code: "interaction_changed", error: "The question changed in the terminal. Nothing was sent." });
    expect(pane.log.keys).toEqual([]);
  });

  test("a screen that blinks between reads still answers the dialog it shows", async () => {
    const { pane, card, answer } = await ready("claude--permission-edit.txt");
    const shown = fixture("claude--permission-edit.txt");
    // The first read after the tap catches the frame where the pending tool's bullet is off.
    const bullet = "\x1b[38;2;153;153;153m● \x1b[0m\x1b[1mWrite";
    expect(shown).toContain(bullet);
    pane.show(shown.replace(bullet, "\x1b[38;2;153;153;153m  \x1b[0m\x1b[1mWrite"));
    const io = { ...pane.io, readPane: async (...args: Parameters<typeof pane.io.readPane>) => {
      const read = await pane.io.readPane(...args);
      pane.show(shown);
      return read;
    } };
    void answer;
    const { interactions } = await ready("claude--permission-edit.txt");
    const result = await interactions.answer("s", io, blocked("p"), { signature: card.signature, optionIndex: 0 });
    expect(result.outcome).toEqual({ ok: true });
    expect(pane.log).toMatchObject({ reads: 2, keys: [["1"]] });
  });

  test("a dialog that really changed is refused after a bounded number of reads", async () => {
    const { pane, card, answer } = await ready("claude--permission-edit.txt");
    pane.show(fixture("claude--permission-bash.txt"));
    expect((await answer({ signature: card.signature, optionIndex: 0 })).outcome).toMatchObject({ code: "interaction_changed" });
    expect(pane.log).toMatchObject({ reads: 4, keys: [] });
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

  test("a Submit walk that never reaches its row sends no Enter and says what happened", async () => {
    const { pane, card, answer } = await ready("claude--wizard-multiselect-checked.txt");
    const next = card.options.find((o) => o.label === "Next")!;
    const result = await answer({ signature: card.signature, optionIndex: next.index });
    expect(result.status).toBe(409);
    expect(result.outcome).toEqual({ ok: false, code: "not_reached", error: "Couldn't reach Next in the terminal. Nothing was submitted." });
    expect(pane.log.keys.flat()).not.toContain("Enter");
  });

  test("a wizard's Back and Next press the arrows its footer names, and only where they lead somewhere", async () => {
    const first = detect("claude--wizard-q1.txt").options.filter((o) => o.role === "nav").map((o) => o.label);
    expect(first).toEqual(["Next"]);
    const { pane, card, answer } = await ready("claude--wizard-q2.txt");
    const back = card.options.find((o) => o.label === "Back")!;
    expect(back.role).toBe("nav");
    expect((await answer({ signature: card.signature, optionIndex: back.index })).keys).toEqual(["Left"]);
    expect(pane.log.keys).toEqual([["Left"]]);
    expect(pushActions(card)).not.toContainEqual(expect.objectContaining({ title: "Back" }));
  });

  test("a checkbox step in a wizard serves no Back: Left is measured on a question and the review, never there", () => {
    expect(detect("claude--wizard-multiselect-final.txt").options.filter((o) => o.role === "nav")).toEqual([]);
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
      push: { enabled: false, publicKey: "", useInteractions: (fn: InteractionLookup) => void (lookup = fn) }, snooze: { until: () => null }, notifyPrefs: { current: () => ({}) }, alerts: { use: () => {} },
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
    const { interactions } = (await res.json()) as { interactions: Interaction[] };
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
    const { interactions } = (await (await list()).json()) as { interactions: Interaction[] };
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
    const refused = await answer({ signature: c.signature, optionIndex: 0, confirm: true });
    expect(refused.status).toBe(409);
    // In the card's own words about the box, and what it did: nothing.
    expect(refused.outcome).toMatchObject({ ok: false, error: "The terminal's text box is in use. Nothing was sent." });
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

describe("Claude's auto-deny countdown (2.1.299)", () => {
  const P0 = join(ROOT, "web/src/lib/harness/claude/fixtures");
  const a = fixture("permission-auto-deny-a-v2299.txt", P0);
  // One second later: only `in 1:50` became `in 1:49`.
  const b = fixture("permission-auto-deny-b-v2299.txt", P0);

  async function shown(at = 1_000_000) {
    const { events, live } = recorder();
    let now = at;
    const interactions = new Interactions(live, { sleep: noSleep, now: () => now });
    const pane = scriptedPane(a, { "1": "" });
    const [card] = await interactions.refresh("s", pane.io, [blocked("p")]);
    pane.log.reads = 0;
    events.length = 0;
    const later = async (screen: string, ms: number) => {
      pane.show(screen);
      now += ms;
      return (await interactions.refresh("s", pane.io, [blocked("p")]))[0];
    };
    return { interactions, pane, card: card!, events, later, answer: (body: Parameters<Interactions["answer"]>[3]) => interactions.answer("s", pane.io, blocked("p"), body) };
  }

  test("the countdown ticking keeps the card: same signature, nothing published", async () => {
    const { card, events, later } = await shown();
    expect((await later(b, 1000))!.signature).toBe(card.signature);
    expect(events).toEqual([]);
  });

  test("Yes tapped on the card a second ago answers", async () => {
    const { pane, card, answer } = await shown();
    pane.show(b);
    expect(await answer({ signature: card.signature, optionIndex: 0 })).toEqual({ status: 200, outcome: { ok: true }, keys: ["1"] });
  });

  test("another command under the same countdown is still refused before any key", async () => {
    const { pane, card, answer } = await shown();
    pane.show(b.replaceAll("scratch2", "scratch3"));
    expect((await answer({ signature: card.signature, optionIndex: 0 })).status).toBe(409);
    expect(pane.log.keys).toEqual([]);
  });

  test("the card says when Claude denies it, read once from the screen", async () => {
    const { card, later } = await shown(1_000_000);
    expect(card.autoDenyAt).toBe(1_000_000 + 110_000);
    expect((await later(b, 1500))!.autoDenyAt).toBe(1_000_000 + 110_000);
  });

  test("a dialog without a countdown carries no deadline", async () => {
    const interactions = new Interactions({ publish() {} }, { sleep: noSleep });
    const [card] = await interactions.refresh("s", scriptedPane(fixture("claude--permission-bash.txt")).io, [blocked("p")]);
    expect(card!.autoDenyAt).toBeUndefined();
  });
});
