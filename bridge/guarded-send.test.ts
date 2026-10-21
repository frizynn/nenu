import { describe, expect, test } from "bun:test";

import {
  OutputTrigger,
  SETTLE_CAP_MS,
  SETTLE_TICK_MS,
  TRIGGER_PATTERN_MAX,
  TRIGGER_PREFIX_MAX,
  WriteLedger,
  guardedSend,
  settleAfterType,
  settleDraft,
  triggerFor,
  triggerHead,
  triggerPattern,
  type GuardedSendDeps,
  type PriorAttempt,
} from "./guarded-send.ts";
import type { OutputMatch, PaneRead, ReadSource } from "./herdr-client.ts";
import type { SendRequest } from "./types.ts";

// A terminal with an input box, in memory: Claude's frame (rule / `❯ draft` / rule / statusline) or
// Codex's (`› draft` over its statusline). It records every Herdr call in order, so a test can say
// exactly which keys went out and when.

const RULE = "─".repeat(60);
const PLACEHOLDER = "\x1b[0m\x1b[1m› \x1b[0m\x1b[2mAsk Codex to do anything\x1b[0m";

type Call = { method: string; arg?: unknown };

class Term {
  agent: string | null = "claude";
  draft = "";
  /** A modal that owns the keyboard: typed text is swallowed and Enter answers it. */
  dialog: string | null = null;
  lines = ["some output", ""];
  /** Typed text reaches the box only when something looks (a read or a wait), never at the call. */
  echo: "immediate" | "on-wait" | "never" = "immediate";
  pending = "";
  enterClears = true;
  failText: "before" | "after" | null = null;
  failKeys = false;
  waitError: string | null = null;
  missing = false;
  /** The CLI attaches a picture pasted alone: its token lands `pictureReads` reads later (-1: never). */
  drawsPictures = true;
  pictureReads = 1;
  /** A picture that never draws its token leaves its path in the box as text, as Claude does when it
   *  cannot attach the file (measured 2.1.306, a path to no file), or leaves nothing (a lost paste). */
  unattached: "text" | "lost" = "lost";
  pictures = 0;
  lateTokens: Array<{ token: string; reads: number }> = [];
  /** Runs before each read with its index, to change the screen between the send's reads. */
  onRead: ((n: number, term: Term) => void) | null = null;
  readonly calls: Call[] = [];
  private reads = 0;

  screen(): string {
    if (this.dialog) return [...this.lines, RULE, this.dialog].join("\n");
    if (this.agent === "codex") {
      return [...this.lines, this.draft ? `\x1b[0m\x1b[1m› \x1b[0m${this.draft}` : PLACEHOLDER, "", "  GPT-6.1-Sol low · /tmp/p · Context 0% used", "  ? for shortcuts"].join("\n");
    }
    return [...this.lines, RULE, `❯ ${this.draft}`, RULE, "  Opus 5.5 | Context 13% used", "  ← for agents"].join("\n");
  }

  private land(): void {
    if (this.echo === "never" || !this.pending) return;
    this.draft += this.pending;
    this.pending = "";
  }

  getPane = async (paneId: string) => {
    this.calls.push({ method: "pane.get" });
    if (this.missing) throw new Error(`herdr pane.get: pane_not_found: pane ${paneId} not found`);
    return { pane_id: paneId, agent: this.agent } as Awaited<ReturnType<GuardedSendDeps["herdr"]["getPane"]>>;
  };

  readPane = async (paneId: string, source: ReadSource, lines: number, format?: string): Promise<PaneRead> => {
    this.calls.push({ method: "pane.read", arg: [source, lines, format] });
    this.onRead?.(this.reads++, this);
    if (this.echo === "immediate") this.land();
    for (const late of this.lateTokens) if (late.reads-- === 0) this.draft += late.token;
    this.lateTokens = this.lateTokens.filter((late) => late.reads >= 0);
    return { pane_id: paneId, text: this.screen(), truncated: false, revision: 0 };
  };

  sendPaneText = async (_paneId: string, text: string) => {
    this.calls.push({ method: "pane.send_text", arg: text });
    if (this.failText === "before") throw new Error("herdr pane.send_text: internal: lost");
    if (!this.dialog && this.drawsPictures && /^\x1b\[200~\/\S+\.png\x1b\[201~$/.test(text)) {
      // Like Claude: the token shows a beat (a read) after the paste, unless it never does.
      this.land();
      if (this.pictureReads >= 0) this.lateTokens.push({ token: `[Image #${++this.pictures}]`, reads: this.pictureReads });
      else if (this.unattached === "text") this.pending += text.replace(/\x1b\[20[01]~/g, "");
      return;
    }
    if (!this.dialog) this.pending += text.replace(/\x1b\[20[01]~/g, "");
    if (this.failText === "after") throw new Error("herdr request timed out");
  };

  sendPaneKeys = async (_paneId: string, keys: string[]) => {
    this.calls.push({ method: "pane.send_keys", arg: keys });
    if (this.failKeys) throw new Error("herdr pane.send_keys: internal: lost");
    for (const key of keys) {
      if (this.dialog) {
        this.dialog = null;
        continue;
      }
      if (key === "Enter" && this.enterClears) {
        this.lines.push(`> ${this.draft}`);
        this.draft = "";
      } else if (key === "Backspace") this.draft = [...this.draft].slice(0, -1).join("");
    }
  };

  waitForOutput = async (_paneId: string, opts: { source: ReadSource; match: OutputMatch; timeoutMs: number; lines?: number }) => {
    this.calls.push({ method: "pane.wait_for_output", arg: opts.match.value });
    if (this.waitError) throw new Error(this.waitError);
    if (this.echo === "on-wait") this.land();
    const re = new RegExp(opts.match.value.replace(/^\(\?m\)/, ""), "m");
    const plain = this.screen().replace(/\x1b\[[0-9;]*m/g, "");
    const line = plain.split("\n").find((row) => re.test(row));
    return line === undefined
      ? ({ matched: false } as const)
      : ({ matched: true, matchedLine: line, read: { pane_id: "p", text: plain, truncated: false, revision: 0 } } as const);
  };

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
  keys(): string[][] {
    return this.calls.filter((c) => c.method === "pane.send_keys").map((c) => c.arg as string[]);
  }
}

const noSleep = async () => {};

function run(term: Term, request: Partial<SendRequest> = {}, opts: { trigger?: OutputTrigger; prior?: PriorAttempt; received?: GuardedSendDeps["received"] } = {}) {
  const deps: GuardedSendDeps = {
    herdr: term,
    paneId: "w1:p1",
    readLines: 200,
    submitKeys: ["Enter"],
    sleep: noSleep,
    ...(opts.trigger ? { trigger: opts.trigger } : {}),
    ...(opts.received ? { received: opts.received } : {}),
  };
  return guardedSend(deps, { text: "deploy the staging build", requestId: "r1", ...request }, opts.prior);
}

describe("guardedSend", () => {
  test("one call types once, sees the text, re-reads, presses Enter once and confirms", async () => {
    const term = new Term();
    const { outcome } = await run(term);
    expect(outcome).toEqual({ ok: true, requestId: "r1", ack: "submitted" });
    expect(term.count("pane.send_text")).toBe(1);
    expect(term.keys()).toEqual([["Enter"]]);
    expect(term.lines.at(-1)).toBe("> deploy the staging build");
    // identity first, then the pre-flight read, and a read right before Enter
    expect(term.methods().slice(0, 3)).toEqual(["pane.get", "pane.read", "pane.send_text"]);
    const enter = term.methods().indexOf("pane.send_keys");
    expect(term.methods()[enter - 1]).toBe("pane.read");
  });

  test("a dialog on screen refuses before anything is typed", async () => {
    const term = new Term();
    term.dialog = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel";
    const { outcome } = await run(term);
    expect(outcome).toMatchObject({ ok: false, stage: "preflight", code: "not_ready", textDelivered: false });
    expect(term.count("pane.send_text")).toBe(0);
    expect(term.count("pane.send_keys")).toBe(0);
  });

  test("Type anyway skips the no-input-box refusal and still withholds Enter until the box shows the text", async () => {
    const term = new Term();
    term.dialog = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel";
    const { outcome } = await run(term, { force: true });
    expect(outcome).toMatchObject({ ok: false, textDelivered: true });
    expect(term.count("pane.send_text")).toBe(1);
    expect(term.count("pane.send_keys")).toBe(0);
  });

  test("Type anyway submits once the text shows up in the box", async () => {
    const term = new Term();
    term.dialog = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel";
    // The pre-flight read sees the dialog; it is gone by the time the text is typed.
    const type = term.sendPaneText;
    term.sendPaneText = async (paneId, text) => {
      term.dialog = null;
      return type(paneId, text);
    };
    const { outcome } = await run(term, { force: true });
    expect(outcome).toEqual({ ok: true, requestId: "r1", ack: "submitted" });
    expect(term.keys()).toEqual([["Enter"]]);
  });

  test("a password prompt is named, and nothing is typed", async () => {
    const term = new Term();
    term.agent = "claude";
    term.dialog = "[sudo] password for fran:";
    const { outcome, trace } = await run(term);
    expect(outcome).toMatchObject({ ok: false, code: "not_ready" });
    expect(outcome.ok === false && outcome.error).toContain("password prompt");
    expect(trace.noEcho).toBe(true);
    expect(term.count("pane.send_text")).toBe(0);
  });

  test("text the box never shows stalls with no Enter", async () => {
    const term = new Term();
    term.echo = "never";
    const { outcome, trace } = await run(term);
    expect(outcome).toMatchObject({ ok: false, stage: "verify", textDelivered: true });
    expect(term.count("pane.send_keys")).toBe(0);
    expect(trace.attempts.length).toBeGreaterThan(1);
  });

  test("a stranded draft is swept before typing, so only the message is submitted", async () => {
    const term = new Term();
    term.draft = "old leftover";
    const { outcome } = await run(term);
    expect(outcome.ok).toBe(true);
    const [sweep, enter] = term.keys();
    expect(sweep?.[0]).toBe("ctrl+k");
    expect(sweep?.filter((k) => k === "Backspace").length).toBe("old leftover".length + 32);
    expect(enter).toEqual(["Enter"]);
    expect(term.lines.at(-1)).toBe("> deploy the staging build");
    expect(term.methods().indexOf("pane.send_keys")).toBeLessThan(term.methods().indexOf("pane.send_text"));
  });

  test("the sweep is bound to the prompt row the pre-flight saw", async () => {
    const term = new Term();
    term.agent = "codex";
    term.draft = "old leftover";
    // The pre-flight read sees the draft; the binding read right before the keys sees another one.
    term.onRead = (n, t) => {
      if (n === 1) t.draft = "someone else typing";
    };
    const { outcome } = await run(term);
    expect(outcome).toMatchObject({ ok: false, stage: "preflight", code: "prompt_changed", textDelivered: false });
    expect(term.count("pane.send_keys")).toBe(0);
    expect(term.count("pane.send_text")).toBe(0);
  });

  test("Codex gets the text as one bracketed paste", async () => {
    const term = new Term();
    term.agent = "codex";
    const { outcome } = await run(term, { text: "first line\n\nlast line" });
    expect(term.calls.find((c) => c.method === "pane.send_text")?.arg).toBe("\x1b[200~first line\n\nlast line\x1b[201~");
    expect(outcome.ok === false ? outcome.stage : "ok").not.toBe("type");
  });

  test("a long Claude send goes as one bracketed paste, a short one as typed text", async () => {
    // Past Claude's paste threshold the PTY can hand the text over in pieces (1 022 + 478 bytes on
    // macOS) and Claude may keep only the last; framed as one paste it arrived whole every time
    // (measured on 2.1.296, 2.1.299 and 2.1.300).
    const long = "word ".repeat(300).trim();
    const term = new Term();
    await run(term, { text: long });
    expect(term.calls.find((c) => c.method === "pane.send_text")?.arg).toBe(`\x1b[200~${long}\x1b[201~`);
    const short = "word ".repeat(150).trim();
    const typed = new Term();
    await run(typed, { text: short });
    expect(typed.calls.find((c) => c.method === "pane.send_text")?.arg).toBe(short);
  });

  const UP = "/home/you/.local/state/nenu/uploads";
  const red = `${UP}/w1_p1-mv8g-0a1b2c3d.png`;
  const blue = `${UP}/w1_p1-mv8g-0a1b2c3e.png`;
  const placed = `first the red one ${red} then the blue one ${blue} and that is all`;

  test("pictures in their places go piece by piece, each path pasted alone after the last one showed (ADR 0104)", async () => {
    const term = new Term();
    const { outcome } = await run(term, { text: placed });
    expect(outcome).toEqual({ ok: true, requestId: "r1", ack: "submitted" });
    expect(term.calls.filter((c) => c.method === "pane.send_text").map((c) => c.arg)).toEqual([
      "first the red one ", `\x1b[200~${red}\x1b[201~`, " then the blue one ", `\x1b[200~${blue}\x1b[201~`, " and that is all",
    ]);
    // Each piece after a picture waits for a read that shows its token.
    const texts = term.calls.flatMap((c, i) => (c.method === "pane.send_text" ? [i] : []));
    expect(term.calls.slice(texts[1]! + 1, texts[2]!).some((c) => c.method === "pane.read")).toBe(true);
    expect(term.lines.at(-1)).toBe("> first the red one [Image #1] then the blue one [Image #2] and that is all");
  });

  test("Codex gets each text piece as a paste and each picture's path alone, its tokens spaced as it draws them", async () => {
    const term = new Term();
    term.agent = "codex";
    term.pictureReads = 0;
    const { outcome } = await run(term, { text: `${red} what is this?` });
    expect(term.calls.filter((c) => c.method === "pane.send_text").map((c) => c.arg)).toEqual([`\x1b[200~${red}\x1b[201~`, "\x1b[200~ what is this?\x1b[201~"]);
    expect(outcome.ok).toBe(true);
  });

  test("a picture the CLI leaves as its path goes as that path, which the agent reads (2026-10-21)", async () => {
    const term = new Term();
    term.pictureReads = -1;
    term.unattached = "text";
    const { outcome } = await run(term, { text: `${red} what is this?` });
    expect(outcome).toEqual({ ok: true, requestId: "r1", ack: "submitted" });
    expect(term.calls.filter((c) => c.method === "pane.send_text").map((c) => c.arg)).toEqual([`\x1b[200~${red}\x1b[201~`, " what is this?"]);
    expect(term.lines.at(-1)).toBe(`> ${red} what is this?`);
  });

  test("a picture past one left as its path still waits for its own token", async () => {
    const term = new Term();
    let pastes = 0;
    const send = term.sendPaneText;
    term.sendPaneText = async (paneId, text) => {
      // The first picture stays text; the second attaches.
      const picture = text.startsWith("\x1b[200~/");
      if (picture && ++pastes === 1) {
        term.pictureReads = -1;
        term.unattached = "text";
      } else term.pictureReads = 1;
      return send(paneId, text);
    };
    const { outcome } = await run(term, { text: placed });
    expect(outcome.ok).toBe(true);
    expect(term.lines.at(-1)).toBe(`> first the red one ${red} then the blue one [Image #1] and that is all`);
  });

  test("a picture that never shows stops the send and clears what it typed, with nothing submitted", async () => {
    const term = new Term();
    term.pictureReads = -1;
    const { outcome } = await run(term, { text: placed });
    expect(outcome).toMatchObject({ ok: false, stage: "type", textDelivered: false });
    if (!outcome.ok) expect(outcome.error).toContain("cleared");
    expect(term.count("pane.send_text")).toBe(2);
    expect(term.draft).toBe("");
    expect(term.keys().flat()).not.toContain("Enter");
  });

  test("a send that stops after typing leaves alone a box holding more than it typed", async () => {
    const term = new Term();
    term.pictureReads = -1;
    // The operator types at the terminal while the picture is awaited.
    term.onRead = (n, t) => {
      if (n === 3) t.draft += "and mine";
    };
    const { outcome } = await run(term, { text: placed });
    expect(outcome).toMatchObject({ ok: false, textDelivered: true });
    expect(term.keys()).toEqual([]);
    expect(term.draft).toContain("and mine");
  });

  test("a write that fails after the first piece says the text may be in the box", async () => {
    const term = new Term();
    let writes = 0;
    const send = term.sendPaneText;
    term.sendPaneText = async (paneId, text) => {
      if (++writes === 2) throw new Error("herdr pane.send_text: internal: lost");
      return send(paneId, text);
    };
    const { outcome } = await run(term, { text: placed });
    expect(outcome).toMatchObject({ ok: false, stage: "type", textDelivered: true });
    expect(term.keys()).toEqual([]);
  });

  test("a retry after a picture that never showed and was not cleared types nothing", async () => {
    const term = new Term();
    term.pictureReads = -1;
    term.draft = "first the red one ";
    const { outcome } = await run(term, { text: placed }, { prior: { typeAttempted: true, textDelivered: true } });
    expect(outcome).toMatchObject({ ok: false, textDelivered: true });
    expect(term.count("pane.send_text")).toBe(0);
    expect(term.keys()).toEqual([]);
  });

  test("a retry whose earlier text may have gone never clears the box it stops on", async () => {
    // "Send it again" would contradict the retry's own answer: the earlier text may be submitted.
    // With a picture only the whole message carries it, so a part of it stops the send at Enter.
    const term = new Term();
    term.draft = "[Image #1] what is this?";
    term.onRead = (n, t) => {
      if (n === 2) t.draft = "[Image #1] what";
    };
    const { outcome } = await run(term, { text: `${red} what is this?` }, { prior: { typeAttempted: true, textDelivered: true } });
    expect(outcome).toMatchObject({ ok: false, textDelivered: true });
    if (!outcome.ok) expect(outcome.error).toContain("with Send it first and Discard");
    expect(term.keys()).toEqual([]);
  });

  test("a retry after a cleared send types it again", async () => {
    const term = new Term();
    term.pictureReads = -1;
    const first = await run(term, { text: placed });
    expect(first.outcome).toMatchObject({ ok: false, textDelivered: false });
    term.pictureReads = 1;
    const { outcome } = await run(term, { text: placed }, { prior: { typeAttempted: true, textDelivered: false } });
    expect(outcome.ok).toBe(true);
    expect(term.lines.at(-1)).toBe("> first the red one [Image #1] then the blue one [Image #2] and that is all");
  });

  test("a retry never takes a long first piece's paste token for the whole message (Claude collapses it)", async () => {
    const long = Array.from({ length: 4 }, (_v, i) => `line ${i} ${"word ".repeat(58)}`).join("\n");
    const term = new Term();
    term.draft = "[Pasted text #1 +3 lines]";
    const { outcome } = await run(term, { text: `${long} ${red} and the end` }, { prior: { typeAttempted: true, textDelivered: true } });
    expect(outcome.ok).toBe(false);
    expect(term.keys()).toEqual([]);
  });

  test("an agent with no adapter gets the message in one write, its paths in place", async () => {
    const term = new Term();
    term.agent = null;
    term.drawsPictures = false;
    await run(term, { text: placed });
    expect(term.calls.filter((c) => c.method === "pane.send_text").map((c) => c.arg)).toEqual([placed]);
  });

  test("a paste carrying an escape sequence is refused before typing", async () => {
    const term = new Term();
    term.agent = "codex";
    const { outcome } = await run(term, { text: "hi\x1b[201~\r" });
    expect(outcome).toMatchObject({ ok: false, textDelivered: false });
    expect(term.count("pane.send_text")).toBe(0);
  });

  test("a lost type ack is followed by a read, and text already in the box is not typed again", async () => {
    const term = new Term();
    term.failText = "after";
    const { outcome } = await run(term);
    expect(outcome.ok).toBe(true);
    expect(term.count("pane.send_text")).toBe(1);
    expect(term.keys()).toEqual([["Enter"]]);
  });

  test("a type that really failed reports nothing delivered", async () => {
    const term = new Term();
    term.failText = "before";
    const { outcome } = await run(term);
    expect(outcome).toMatchObject({ ok: false, stage: "type", textDelivered: false });
    expect(term.count("pane.send_keys")).toBe(0);
  });

  test("a retry of an attempt that typed submits the text in the box instead of retyping", async () => {
    const term = new Term();
    term.draft = "deploy the staging build";
    const { outcome } = await run(term, {}, { prior: { typeAttempted: true, textDelivered: true } });
    expect(outcome.ok).toBe(true);
    expect(term.count("pane.send_text")).toBe(0);
    expect(term.keys()).toEqual([["Enter"]]);
  });

  test("a retry of an attempt that delivered the text finds the box empty and types nothing", async () => {
    const term = new Term();
    const { outcome } = await run(term, {}, { prior: { typeAttempted: true, textDelivered: true } });
    expect(outcome).toMatchObject({ ok: false, textDelivered: true });
    expect(term.count("pane.send_text")).toBe(0);
    expect(term.count("pane.send_keys")).toBe(0);
  });

  test("a retry of an attempt that typed does not type while the box cannot be read", async () => {
    const term = new Term();
    term.onRead = () => {
      throw new Error("herdr request timed out");
    };
    const { outcome } = await run(term, {}, { prior: { typeAttempted: true, textDelivered: false } });
    expect(outcome.ok).toBe(false);
    expect(term.count("pane.send_text")).toBe(0);
    expect(term.count("pane.send_keys")).toBe(0);
  });

  test("a retry of an attempt that typed on a pane with no adapter types nothing", async () => {
    const term = new Term();
    term.agent = "pi";
    const { outcome } = await run(term, {}, { prior: { typeAttempted: true, textDelivered: true } });
    expect(outcome).toMatchObject({ ok: false, textDelivered: true });
    expect(term.count("pane.send_text")).toBe(0);
    expect(term.count("pane.send_keys")).toBe(0);
  });

  test("without an earlier attempt, the same text in the box is a stranded draft and is swept", async () => {
    const term = new Term();
    term.draft = "deploy the staging build";
    await run(term);
    expect(term.keys()[0]?.[0]).toBe("ctrl+k");
    expect(term.count("pane.send_text")).toBe(1);
  });

  test("the box changing right before Enter withholds it", async () => {
    const term = new Term();
    term.onRead = (n, t) => {
      if (n === 2) t.dialog = "Do you want to proceed?\n❯ 1. Yes\n  2. No";
    };
    const { outcome } = await run(term);
    expect(outcome).toMatchObject({ ok: false, stage: "submit", textDelivered: true });
    expect(term.count("pane.send_keys")).toBe(0);
  });

  test("a failed Enter says the text is typed and not submitted", async () => {
    const term = new Term();
    term.failKeys = true;
    const { outcome } = await run(term);
    expect(outcome).toMatchObject({ ok: false, stage: "submit", textDelivered: true });
  });

  test("Enter the box ignores is reported as unconfirmed, not sent", async () => {
    const term = new Term();
    term.enterClears = false;
    const { outcome } = await run(term);
    expect(outcome).toMatchObject({ ok: false, stage: "confirm", textDelivered: true });
    expect(term.keys()).toEqual([["Enter"]]);
  });

  test("a stale expected prompt refuses with prompt_changed", async () => {
    const term = new Term();
    const { outcome } = await run(term, { expectedPrompt: "Approve this command?\n1. Yes\n2. No" });
    expect(outcome).toMatchObject({ ok: false, code: "prompt_changed", textDelivered: false });
    expect(term.count("pane.send_text")).toBe(0);
  });

  test("a pane that is gone refuses at identity", async () => {
    const term = new Term();
    term.missing = true;
    const { outcome } = await run(term);
    expect(outcome).toMatchObject({ ok: false, stage: "preflight", textDelivered: false });
    expect(term.methods()).toEqual(["pane.get"]);
  });

  test("the trigger wakes the wait and the adapter still decides", async () => {
    const term = new Term();
    term.echo = "on-wait";
    const trigger = new OutputTrigger();
    const { outcome } = await run(term, {}, { trigger });
    expect(outcome.ok).toBe(true);
    const waits = term.calls.filter((c) => c.method === "pane.wait_for_output");
    expect(waits).toHaveLength(1);
    expect(waits[0]?.arg).toBe(triggerPattern("deploy the staging build"));
    // the wait's match is followed by a fresh read before anything else
    const at = term.methods().indexOf("pane.wait_for_output");
    expect(term.methods()[at + 1]).toBe("pane.read");
  });

  test("a match the adapter rejects hands the rest of the window to polling", async () => {
    const term = new Term();
    term.echo = "never";
    term.lines.push("❯ deploy the staging build"); // an old copy in the transcript
    const { outcome } = await run(term, {}, { trigger: new OutputTrigger() });
    expect(outcome).toMatchObject({ ok: false, stage: "verify" });
    expect(term.count("pane.wait_for_output")).toBe(1);
    expect(term.count("pane.send_keys")).toBe(0);
  });

  test("Herdr refusing the regex turns the trigger off and polling finishes the send", async () => {
    const term = new Term();
    term.echo = "on-wait";
    term.waitError = "herdr pane.wait_for_output: invalid_regex: bad";
    const trigger = new OutputTrigger();
    let polled = 0;
    const { outcome } = await guardedSend(
      {
        herdr: term,
        paneId: "w1:p1",
        readLines: 200,
        submitKeys: ["Enter"],
        trigger,
        sleep: async () => {
          polled++;
          term.echo = "immediate";
        },
      },
      { text: "deploy the staging build", requestId: "r1" },
    );
    expect(outcome.ok).toBe(true);
    expect(polled).toBeGreaterThan(0);
    expect(trigger.available()).toBe(false);
  });

  test("an old server without the method also falls back", async () => {
    const term = new Term();
    term.waitError = "herdr pane.wait_for_output: invalid_request: invalid request: unknown variant `pane.wait_for_output`";
    term.echo = "on-wait";
    const trigger = new OutputTrigger();
    await run(term, {}, { trigger });
    expect(trigger.available()).toBe(false);
  });

  test("a harness with no adapter types, settles on the screen's change and presses Enter", async () => {
    const term = new Term();
    term.agent = "pi";
    const sleeps: number[] = [];
    const { outcome, trace } = await guardedSend(
      { herdr: term, paneId: "w1:p1", readLines: 200, submitKeys: ["Enter"], sleep: async (ms) => void sleeps.push(ms) },
      { text: "hello pi", requestId: "r1" },
    );
    expect(outcome.ok).toBe(true);
    expect(trace.unverified).toBe(true);
    expect(term.methods()).toEqual(["pane.get", "pane.read", "pane.send_text", "pane.read", "pane.read", "pane.send_keys"]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(SETTLE_CAP_MS);
  });
});

// The `reply.unsent` of 2026-10-14 16:08:47 (pane w53:p1), with the prose replaced: three paragraphs
// and two uploaded images, which Claude 2.1.299 took as one paste. It attached both paths and drew
// `[Image #1] [Image #2]` ahead of the paragraphs, one row each (blank lines dropped), wrapped at 120
// columns. Seven reads saw that draft and called it someone else's.
describe("guardedSend: what Claude logged", () => {
  // The screen cannot tell a whole long send from one that lost its head: the box shows Claude's
  // paste token, or only the literal tail, which is a slice of the message either way. Claude's own
  // log says what it received (ADR 0067), so it has the last word on a send it can judge.
  const sent = Array.from({ length: 240 }, (_, i) => `word${i}`).join(" ");
  function logged(text: string | null, after = 0) {
    const asked: number[] = [];
    return { asked, received: async (since: number) => (asked.push(since) > after ? text : null) };
  }

  test("a message Claude logged without its head is reported incomplete, not sent", async () => {
    const term = new Term();
    const log = logged(sent.slice(1022));
    const { outcome } = await run(term, { text: sent }, { received: log.received });
    expect(outcome).toMatchObject({ ok: false, stage: "confirm", code: "incomplete", textDelivered: true });
    expect(outcome.ok ? "" : outcome.error).toContain("incomplete");
    expect(term.keys()).toEqual([["Enter"]]);
  });

  test("a message logged whole is sent once the log shows it", async () => {
    const log = logged(sent, 2);
    const { outcome } = await run(new Term(), { text: sent }, { received: log.received });
    expect(outcome).toEqual({ ok: true, requestId: "r1", ack: "submitted" });
    expect(log.asked).toHaveLength(3);
  });

  test("a message the log never shows stays sent: the screen already confirmed it", async () => {
    const log = logged(null);
    const { outcome } = await run(new Term(), { text: sent }, { received: log.received });
    expect(outcome.ok).toBe(true);
    expect(log.asked.length).toBeGreaterThan(1);
  });
});

describe("guardedSend: a message with images on Claude", () => {
  const paragraphs = [
    "There is a problem in the terminal view: instead of two buttons it should offer a list with the agent and its permission level, otherwise picking from the phone is impossible",
    "then in the projects the strip under the chat shows up all the time and should not, it belongs in another tab, and the diffs that were never implemented are still missing",
    "for that open one tab per agent with its own task, debug everything first at a low level and only then implement it",
  ];
  // Paths the operator typed into a long message, not Nenu's uploads: those go piece by piece (ADR 0104).
  const images = ["/home/u/project/shots/before.png", "/home/u/project/shots/after.png"];
  const sent = `${paragraphs.join("\n\n")} ${images.join(" ")}`;

  /** The box's rows for `text`: word-wrapped to the box's width, continuation rows indented. */
  const boxed = (text: string, width = 118) =>
    text
      .split("\n")
      .map((line) => {
        const rows: string[] = [];
        let row = "";
        for (const word of line.split(" ")) {
          if (row && row.length + 1 + word.length > width) {
            rows.push(row);
            row = word;
          } else row = row ? `${row} ${word}` : word;
        }
        return [...rows, row].join("\n  ");
      })
      .join("\n  ");

  /** A terminal whose Claude draws `shown` for whatever the send types. */
  function claudeShowing(shown: string): Term {
    const term = new Term();
    term.sendPaneText = async (_paneId, text) => {
      term.calls.push({ method: "pane.send_text", arg: text });
      term.pending += boxed(shown);
    };
    return term;
  }

  test("the image tokens ahead of the whole message are the message: Enter once, sent once", async () => {
    const term = claudeShowing(`[Image #1] [Image #2]${paragraphs.join("\n")}`);
    const { outcome, trace } = await run(term, { text: sent });
    expect(outcome).toEqual({ ok: true, requestId: "r1", ack: "submitted" });
    expect(term.count("pane.send_text")).toBe(1);
    expect(term.keys()).toEqual([["Enter"]]);
    expect(trace.attempts.filter((read) => read === "other-draft").length).toBeLessThanOrEqual(1);
    expect(term.lines.filter((line) => line.startsWith("> [Image #1] [Image #2]There is a problem"))).toHaveLength(1);
  });

  test("a paragraph that is not the one typed withholds Enter", async () => {
    const term = claudeShowing(`[Image #1] [Image #2]${[paragraphs[0], paragraphs[1]!.replace("diffs", "tests"), paragraphs[2]].join("\n")}`);
    const { outcome } = await run(term, { text: sent });
    expect(outcome).toMatchObject({ ok: false, stage: "verify", textDelivered: true });
    expect(term.count("pane.send_keys")).toBe(0);
  });

  test("one image attached where two were sent withholds Enter", async () => {
    const term = claudeShowing(`[Image #1]${paragraphs.join("\n")}`);
    const { outcome } = await run(term, { text: sent });
    expect(outcome).toMatchObject({ ok: false, stage: "verify", textDelivered: true });
    expect(term.count("pane.send_keys")).toBe(0);
  });
});

describe("settleAfterType", () => {
  test("returns once a change holds for one tick", async () => {
    const screens = ["typed", "typed"];
    let reads = 0;
    const sleeps: number[] = [];
    await settleAfterType(async () => screens[reads++] ?? "typed", "before", async (ms) => void sleeps.push(ms));
    expect(reads).toBe(2);
    expect(sleeps).toEqual([SETTLE_TICK_MS, SETTLE_TICK_MS]);
  });

  test("waits the cap when the screen never changes, and when there is no baseline", async () => {
    for (const before of ["same", null]) {
      const sleeps: number[] = [];
      await settleAfterType(async () => "same", before, async (ms) => void sleeps.push(ms));
      expect(sleeps.reduce((a, b) => a + b, 0)).toBe(SETTLE_CAP_MS);
    }
  });
});

describe("triggerPattern", () => {
  const compile = (pattern: string) => new RegExp(pattern.replace(/^\(\?m\)/, ""), "m");

  test("anchors the escaped head after a prompt glyph and U+00A0, or a paste placeholder", () => {
    const re = compile(triggerPattern("fix (a+b)*c? now"));
    expect(re.test("❯ fix (a+b)*c? now")).toBe(true);
    expect(re.test("  › fix (a+b)*c? now and more")).toBe(true);
    expect(re.test("❯ fix aab c now")).toBe(false);
    expect(re.test("❯ fix")).toBe(false);
    expect(re.test("[Pasted text #1 +40 lines]")).toBe(true);
    expect(re.test("[Pasted Content 1204 chars]")).toBe(true);
    expect(re.test("plain output mentioning fix (a+b)*c?")).toBe(false);
  });

  test("a head that starts with a wide or invisible character leaves only the placeholder", () => {
    expect(triggerPattern("🙂 hi")).toBe("(?m)\\[Pasted ");
    expect(triggerPattern("   ")).toBe("(?m)\\[Pasted ");
  });

  // Random strings over the characters most likely to break an escape: every ASCII punctuation mark,
  // controls, U+00A0, combining marks, CJK, emoji and lone surrogates.
  test("fuzz: always bounded, always compiles, quotes the head literally", () => {
    const alphabet = [
      ..."abcXYZ019 \t\n\r",
      ..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
      " ", "́", "​", "\x00", "\x1b", "\x7f", "日", "本", "😀", "👨‍👩‍👧", "\ud800", "\udfff", "ñ", "ß",
    ];
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      let text = "";
      const len = rand(60);
      for (let j = 0; j < len; j++) text += alphabet[rand(alphabet.length)];
      const pattern = triggerPattern(text);
      expect(pattern.length).toBeLessThanOrEqual(TRIGGER_PATTERN_MAX);
      expect(pattern.startsWith("(?m)")).toBe(true);
      // No lone surrogate may reach Herdr: its JSON parser would refuse the whole request.
      expect(/[\ud800-\udfff]/.test(pattern.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))).toBe(false);
      const re = compile(pattern);
      const head = triggerHead(text);
      expect(text.trimStart().startsWith(head)).toBe(true);
      expect(head.length).toBeLessThanOrEqual(TRIGGER_PREFIX_MAX);
      if (!head) {
        expect(pattern).toBe("(?m)\\[Pasted ");
        continue;
      }
      // The pattern matches the message as Claude paints it.
      expect(re.test(`❯\u00a0${head}`)).toBe(true);
      // A meta character in the head is matched as itself: swapping it for a letter breaks the match.
      const meta = head.search(/[.*+?^${}()|[\]\\]/);
      if (meta >= 0) {
        const swapped = head.slice(0, meta) + "Q" + head.slice(meta + 1);
        expect(re.test(`❯\u00a0${swapped}`)).toBe(false);
      }
    }
  });
});

describe("OutputTrigger", () => {
  test("goes off for a cooldown and comes back", () => {
    let now = 0;
    const trigger = new OutputTrigger(() => now);
    expect(trigger.available()).toBe(true);
    trigger.disable();
    expect(trigger.available()).toBe(false);
    now = OutputTrigger.COOLDOWN_MS;
    expect(trigger.available()).toBe(true);
  });

  test("a runtime's trigger listens to the poker's rejected output watches", () => {
    let rejected: ((reason: string) => void) | null = null;
    const poker = {
      onOutputWatchesRejected(cb: (reason: string) => void) {
        rejected = cb;
        return () => {};
      },
    };
    const trigger = triggerFor(poker);
    expect(triggerFor(poker)).toBe(trigger);
    expect(trigger.available()).toBe(true);
    rejected!("invalid_regex: look-around not supported");
    expect(trigger.available()).toBe(false);
  });
});

describe("WriteLedger", () => {
  type Out = { ok: boolean; n: number };
  const ledger = () => new WriteLedger<Out>((o) => o.ok);

  test("replays a success without running again", async () => {
    const l = ledger();
    let runs = 0;
    const op = async () => ({ ok: true, n: ++runs });
    expect(await l.run("k", "f", op)).toEqual({ outcome: { ok: true, n: 1 }, replayed: false });
    expect(await l.run("k", "f", op)).toEqual({ outcome: { ok: true, n: 1 }, replayed: true });
    expect(runs).toBe(1);
  });

  test("runs a failure again and hands it the earlier outcome", async () => {
    const l = ledger();
    const priors: (Out | null)[] = [];
    let runs = 0;
    const op = async (prior: Out | null) => {
      priors.push(prior);
      return { ok: ++runs > 1, n: runs };
    };
    expect(await l.run("k", "f", op)).toEqual({ outcome: { ok: false, n: 1 }, replayed: false });
    expect(await l.run("k", "f", op)).toEqual({ outcome: { ok: true, n: 2 }, replayed: false });
    expect(await l.run("k", "f", op)).toEqual({ outcome: { ok: true, n: 2 }, replayed: true });
    expect(priors).toEqual([null, { ok: false, n: 1 }]);
  });

  test("shares one in-flight run between concurrent retries", async () => {
    const l = ledger();
    let release: (o: Out) => void = () => {};
    const first = l.run("k", "f", () => new Promise<Out>((r) => (release = r)));
    const second = l.run("k", "f", async () => ({ ok: true, n: 99 }));
    release({ ok: true, n: 1 });
    expect(await first).toEqual({ outcome: { ok: true, n: 1 }, replayed: false });
    expect(await second).toEqual({ outcome: { ok: true, n: 1 }, replayed: true });
  });

  test("refuses the same id with another payload, even after a failure", async () => {
    const l = ledger();
    await l.run("k", "f", async () => ({ ok: false, n: 1 }));
    expect(await l.run("k", "other", async () => ({ ok: true, n: 2 }))).toEqual({ conflict: true });
  });

  test("forgets an id whose run threw, and entries past their TTL", async () => {
    let now = 0;
    const l = new WriteLedger<Out>((o) => o.ok, () => now);
    await expect(l.run("k", "f", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await l.run("k", "other", async () => ({ ok: true, n: 1 }))).toMatchObject({ replayed: false });
    now = WriteLedger.TTL_MS;
    expect(await l.run("k", "f", async () => ({ ok: true, n: 2 }))).toEqual({ outcome: { ok: true, n: 2 }, replayed: false });
  });
});

describe("settleDraft", () => {
  const deps = (term: Term) => ({ herdr: term, paneId: "w1:p1", readLines: 200, sleep: noSleep });

  test("clears the box while it holds exactly the draft taken over, and confirms it emptied (ADR 0112)", async () => {
    const term = new Term();
    term.draft = "mira como se ve";
    // As the phone read it: a word cut where the box wrapped comes back with a space in it.
    expect(await settleDraft(deps(term), "mira co mo se ve")).toEqual({ ok: true });
    expect(term.draft).toBe("");
    expect(term.keys()[0]![0]).toBe("ctrl+k");
  });

  test("leaves a box that changed since the phone read it", async () => {
    const term = new Term();
    term.draft = "mira como se ve y algo más";
    expect((await settleDraft(deps(term), "mira como se ve")).ok).toBe(false);
    expect(term.keys()).toEqual([]);
    expect(term.draft).toBe("mira como se ve y algo más");
  });

  test.each([
    ["a picture the CLI attached", "[Image #1] fix this"],
    ["a paste the CLI collapsed", "why does this fail [Pasted text #1 +80 lines]"],
    ["a picture cut where the box wrapped", "fix this [Ima ge #1]"],
  ])("leaves a draft holding %s: only the CLI has it, and the phone's copy is its token", async (_case, held) => {
    const term = new Term();
    term.draft = held;
    expect((await settleDraft(deps(term), held)).ok).toBe(false);
    expect(term.keys()).toEqual([]);
    expect(term.draft).toBe(held);
  });

  test("presses nothing into a dialog", async () => {
    const term = new Term();
    term.draft = "mira";
    term.dialog = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel";
    for (const action of ["take", "discard", "send"] as const) expect((await settleDraft(deps(term), "mira", action)).ok).toBe(false);
    expect(term.keys()).toEqual([]);
  });

  test.each([
    ["words", "borrador escrito a mano"],
    ["a paste the CLI collapsed", "[Pasted text #37 +27 lines]"],
  ])("discards a draft holding %s the operator saw and chose to drop (ADR 0114)", async (_case, held) => {
    const term = new Term();
    term.draft = held;
    expect(await settleDraft(deps(term), held, "discard")).toEqual({ ok: true });
    expect(term.draft).toBe("");
  });

  test("sends the draft with the submit key and waits for the box to let go of it (ADR 0114)", async () => {
    const term = new Term();
    term.draft = "[Pasted text #37 +27 lines]";
    expect(await settleDraft(deps(term), "[Pasted text #37 +27 lines]", "send")).toEqual({ ok: true });
    expect(term.keys()).toEqual([["Enter"]]);
    expect(term.draft).toBe("");
  });

  test("sends nothing when the box holds other text than the phone showed", async () => {
    const term = new Term();
    term.draft = "borrador y algo más";
    expect((await settleDraft(deps(term), "borrador", "send")).ok).toBe(false);
    expect((await settleDraft(deps(term), "borrador", "discard")).ok).toBe(false);
    expect(term.keys()).toEqual([]);
  });
});
