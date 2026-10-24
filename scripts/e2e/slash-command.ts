import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { DESKTOP, PHONE, type Browser, type Page } from "./browser.ts";
import type { TestBridge } from "./bridge.ts";

// The slash-command bench: a `/name` the operator types wears the command tint in the draft and in
// the sent message (lib/slash-command.ts), on a phone and a desk, light and dark. The tint is a pill
// under the textarea's own characters (draft-chip-layer.tsx), so at every step of a walk across a
// line's end the layer must wrap where the textarea does and the pill must stay one box. The draft
// also holds a path and a URL, which must stay plain; Backspace and a paste edit the command in
// place. Then the message is sent and drawn in the thread from the pane's log (run.ts `slash-command`,
// which runs it under WebKit and Chromium).

export interface Check { name: string; ok: boolean; detail?: string }

const LEAD = "pero digo cuándo escribo por ejemplo ";
const COMMAND = "/skill";
const TAIL = " que en el chat se vea azulito, no /Users/fran/notes ni https://x.dev/a/b";

/** The commands' pills in the draft, from the draft's top, and whether the layer wraps as the draft. */
function measure() {
  const field = document.querySelector("textarea")!;
  const layer = document.querySelector<HTMLElement>(".draft-chip-layer");
  const top = field.getBoundingClientRect().top - field.scrollTop;
  const pills = Array.from(document.querySelectorAll(".draft-chip-layer .slash-command")).map((pill) => ({
    text: pill.textContent,
    boxes: Array.from(pill.getClientRects()).map((r) => ({ left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top - top) })),
  }));
  return { pills, field: field.scrollHeight, layer: layer?.scrollHeight ?? null, value: field.value };
}

let seq = 0;
const row = (text: string, ts: number) => JSON.stringify({
  uuid: `5c000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, parentUuid: null,
  timestamp: new Date(ts).toISOString(), type: "user", message: { role: "user", content: text },
}) + "\n";

export async function slashCommandBench(bridge: TestBridge, browser: Browser, engine: string, outDir: string): Promise<{ checks: Check[]; shots: string[]; seen: Record<string, unknown> }> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const seen: Record<string, unknown> = {};
  const pane = bridge.herd!.idle;
  const shot = async (page: Page, label: string) => {
    const path = join(outDir, `slash-command-${engine}-${label}.png`);
    await page.screenshot({ path, animations: "disabled" });
    shots.push(path);
  };
  for (const [name, device] of [["phone", PHONE], ["desk", DESKTOP]] as const) {
    for (const scheme of ["dark", "light"] as const) {
      const label = `${name}-${scheme}`;
      const context = await browser.newContext({ ...device, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
      const box = page.getByRole("textbox").first();
      await box.waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1200);
      await box.click();
      await box.fill("");
      await page.keyboard.type(`${LEAD}${COMMAND}${TAIL}`);
      const typed = await page.evaluate(measure, null);
      checks.push({ name: `${engine} ${label}: only the command wears the tint in the draft`, ok: JSON.stringify(typed.pills.map((p) => p.text)) === JSON.stringify([COMMAND]), detail: JSON.stringify(typed.pills) });
      await shot(page, `${label}-draft`);

      // Walk the command to the right one letter at a time, typed before the space that leads it, until
      // it has moved down a line.
      if (scheme === "dark") {
        const startTop = typed.pills[0]?.boxes[0]?.top ?? 0;
        const bad: unknown[] = [];
        let steps = 0;
        for (; steps < 400; steps++) {
          const m = await page.evaluate(measure, null);
          const pill = m.pills.find((p) => p.text === COMMAND);
          if (!pill || pill.boxes.length !== 1 || m.field !== m.layer) bad.push({ steps, ...m });
          if (pill && pill.boxes[0]!.top > startTop + 4) {
            await shot(page, `${label}-moved`);
            break;
          }
          await page.evaluate((at: number) => {
            const field = document.querySelector("textarea")!;
            field.focus();
            field.setSelectionRange(at, at);
          }, (await box.inputValue()).indexOf(` ${COMMAND}`));
          await page.keyboard.type("x");
        }
        seen[`${engine}-${label}`] = { steps, bad: bad.slice(0, 3) };
        checks.push({ name: `${engine} ${label}: the command crossed a line's end`, ok: steps < 400, detail: `${steps} steps` });
        checks.push({ name: `${engine} ${label}: the pill stayed one box and the layer wrapped as the draft`, ok: bad.length === 0, detail: JSON.stringify(bad.slice(0, 2)) });

        // The textarea still owns the text: Backspace at the command's end and a paste after it edit
        // its characters, and the tint follows them.
        await box.fill("");
        await page.keyboard.type(`${COMMAND} now`);
        await page.evaluate((at: number) => document.querySelector("textarea")!.setSelectionRange(at, at), COMMAND.length);
        await page.keyboard.press("Backspace");
        const backspaced = await page.evaluate(measure, null);
        await page.keyboard.insertText("l-check");
        const pasted = await page.evaluate(measure, null);
        checks.push({ name: `${engine} ${label}: Backspace and a paste edit the command, and its tint follows`,
          ok: backspaced.value === "/skil now" && backspaced.pills[0]?.text === "/skil" && pasted.value === "/skill-check now" && pasted.pills[0]?.text === "/skill-check",
          detail: JSON.stringify({ backspaced, pasted }) });
        await box.fill(`${LEAD}${COMMAND}${TAIL}`);
      }

      // Sent: the pane's log shows the message, and the thread draws it with the command tinted.
      if (name === "phone" && scheme === "dark") {
        const before = bridge.fake!.submitted.length;
        await page.getByRole("button", { name: "Send", exact: true }).click();
        for (let i = 0; i < 60 && !bridge.fake!.submitted.slice(before).some((s) => s.text.includes(COMMAND)); i++) await page.waitForTimeout(100);
        await appendFile(bridge.herd!.journals.get(pane)!, row(`${LEAD}${COMMAND}${TAIL}`, bridge.now()));
      }
      const bubble = page.locator('[data-speaker="user"]').filter({ hasText: `${LEAD}${COMMAND}` }).last();
      const drawn = await bubble.waitFor({ timeout: 15_000 }).then(() => true, () => false);
      const tinted = drawn ? await bubble.locator(".slash-command").allTextContents() : [];
      checks.push({ name: `${engine} ${label}: the sent message draws only the command tinted`, ok: JSON.stringify(tinted) === JSON.stringify([COMMAND]), detail: JSON.stringify({ drawn, tinted }) });
      if (drawn) {
        await box.fill(`${COMMAND} que en el chat`);
        await bubble.scrollIntoViewIfNeeded();
        await shot(page, `${label}-sent`);
      }
      await context.close();
    }
  }
  return { checks, shots, seen };
}
