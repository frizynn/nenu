// Pure helpers for text typed into a dialog. No imports, so the bridge can share them without
// pulling the browser API client (and React) into its typecheck.

/**
 * Longest feedback Nenu will type into a plan dialog.
 *
 * Not a comfort limit — a grammar one. The row does not window long text: Claude re-flows the whole
 * value across as many display lines as it needs, which pushes the dialog's footer away from its
 * options. `MAX_FEEDBACK_WRAP` (harness/claude/prompt-select.ts) is how far that may go before the
 * screen stops parsing at all, and this is sized to stay inside it even on a narrow pane (~4 lines of
 * ~60 usable columns). Longer text isn't dangerous — the read-back check simply refuses and nothing is
 * submitted — but the dialog would drop off the phone, so we don't let it happen.
 */
export const FEEDBACK_MAX_LENGTH = 240;

/**
 * Sanitize free text before it is typed into a focused TUI input via the reply path. Collapse
 * whitespace to single spaces FIRST (so \t \n \r become word boundaries, not glue), then strip any
 * remaining C0/C1 control chars. Pasted clipboard text can smuggle in ESC (\x1b — blurs/cancels the
 * dialog), BEL (\x07 — "edit in nano"), ETX (\x03), etc., which the reply path would deliver
 * straight into the focused input BEFORE the readback check — so they must never reach it.
 */
export function sanitizeTypedText(text: string, maxLen: number): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, maxLen);
}
