import { Terminal } from "@/components/ui/icon";

import { Button } from "@/components/ui/button";

interface TerminalDraftPreviewProps {
  /** The live host/terminal draft text — the caller feeds it the RAW per-poll line, so host typing
   * streams in here. Display-only: this component never writes back into the composer. */
  text: string;
  /** The agent's name, for the heading. */
  name: string;
  /** Deliberate takeover — copy the current draft into the phone-owned composer and hide the preview.
   * `null` withdraws the affordance: the line holds the harness's OWN opaque token rather than the
   * user's words (Claude collapses a long paste into `[Pasted text #N +M lines]`), and copying that
   * into the composer would make the literal string the message. The preview still shows it. */
  onTakeOver: (() => void) | null;
  /** Press Enter on it in the terminal; `null` where nothing may be written (read-only, gone pane). */
  onSend: (() => void) | null;
  /** Clear it from the terminal; `null` where nothing may be written. */
  onDiscard: (() => void) | null;
  /** A Send or Discard is on its way. */
  busy: boolean;
  /** A message from this composer waits on the operator's call (ADR 0114). */
  waiting: boolean;
  /** Take the waiting message back: it stays in the composer, unsent. */
  onCancel: () => void;
}

// The text in the agent's own input box, which a send must neither sweep unseen nor wait on unsaid
// (ADR 0114): typed at the terminal, recalled from the CLI's queue, or left by a send that stopped.
// The composer input stays phone-owned — a host draft is never written into it implicitly — and the
// operator settles it here in one tap: Send it first (Enter in the terminal), Add to my message (Take
// over: it joins the composer's draft and leaves the terminal) or Discard. A message sent while it is
// there waits for that tap and then goes on its own. Its TEXT tracks the live line, so watching the host
// type streams straight into this block. Add to my message is withdrawn when the line is only the
// harness's own token (`onTakeOver`); Send it first and Discard act on the line whole.
export function TerminalDraftPreview({ text, name, onTakeOver, onSend, onDiscard, busy, waiting, onCancel }: TerminalDraftPreviewProps) {
  const action = "hit-area h-7 shrink-0 px-2 text-footnote font-medium";
  return (
    <div role="group" aria-label={`Text in ${name}'s box`} className="mb-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-footnote text-muted-foreground">
      <div className="flex items-start gap-1.5">
        <Terminal className="mt-0.5 size-3 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">Text in {name}'s box</div>
          <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words font-mono text-footnote text-muted-foreground">
            {text}
          </div>
          {waiting && <p role="status" className="mt-1 text-foreground">Your message goes as soon as you choose.</p>}
        </div>
      </div>
      {(onSend || onTakeOver || onDiscard || waiting) && (
        <div className="mt-1 flex flex-wrap items-center justify-end gap-x-1">
          {onSend && <Button variant={waiting ? "secondary" : "ghost"} size="sm" className={action} disabled={busy} onClick={onSend}>Send it first</Button>}
          {onTakeOver && <Button variant="ghost" size="sm" className={action} disabled={busy} onClick={onTakeOver}>Add to my message</Button>}
          {onDiscard && <Button variant="ghost" size="sm" className={action} disabled={busy} onClick={onDiscard}>Discard</Button>}
          {waiting && <Button variant="ghost" size="sm" className={action} onClick={onCancel}>Don't send mine</Button>}
        </div>
      )}
    </div>
  );
}
