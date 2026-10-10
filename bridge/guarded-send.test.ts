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
    return { pane_id: paneId, text: this.screen(), truncated: false, revision: 0 };
  };

  sendPaneText = async (_paneId: string, text: string) => {
    this.calls.push({ method: "pane.send_text", arg: text });
    if (this.failText === "before") throw new Error("herdr pane.send_text: internal: lost");
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

function run(term: Term, request: Partial<SendRequest> = {}, opts: { trigger?: OutputTrigger; prior?: PriorAttempt } = {}) {
  const deps: GuardedSendDeps = {
    herdr: term,
    paneId: "w1:p1",
    readLines: 200,
    submitKeys: ["Enter"],
    sleep: noSleep,
    ...(opts.trigger ? { trigger: opts.trigger } : {}),
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
