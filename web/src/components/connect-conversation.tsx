import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRevalidator } from "react-router";
import { ChevronDown } from "lucide-react";
import { connectConversation, fetchConversations } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { cn } from "@/lib/utils";

/**
 * True where the recovery is the surface's one way forward (the empty pane's card): Find is then the
 * large action every empty state offers. Elsewhere, as inside the ⋯ menu, it stays a full-width
 * outlined row among the menu's plain rows.
 */
export const RecoveryLeads = createContext(false);

/**
 * Explicit recovery: never choose a conversation just because its directory matches. One way forward
 * at a time: find the conversations running here, or type the ID Codex's /status shows, kept behind
 * its own disclosure so a bare field does not compete with the composer.
 */
export function ConnectConversation({ paneId, session, disabled, onConnected }: {
  paneId: string; session?: string; disabled: boolean; onConnected(): void;
}) {
  const [choices, setChoices] = useState<Array<{ id: string; title: string }> | null>(null);
  const [manual, setManual] = useState(false);
  const [id, setId] = useState("");
  const [busy, setBusy] = useState<"find" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const revalidator = useRevalidator();
  const leads = useContext(RecoveryLeads);
  const regionId = useId();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy("find"); setError(null);
    try { setChoices((await fetchConversations(paneId, session, controller.signal)).conversations); }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load conversations."); }
    finally { inFlight.current = false; if (!controller.signal.aborted) setBusy(null); }
  }
  async function connect() {
    if (disabled || inFlight.current || !id.trim()) return;
    inFlight.current = true; setBusy("connect"); setError(null);
    try {
      const result = await connectConversation(paneId, id.trim(), session);
      if (!result.ok) throw new Error(result.error);
      await revalidator.revalidate();
      onConnected();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not connect conversation."); }
    finally { inFlight.current = false; setBusy(null); }
  }

  // Opened by a tap, the field takes focus inside that tap so a phone raises its keyboard.
  function toggleManual() {
    flushSync(() => setManual(!manual));
    if (!manual) input.current?.focus();
  }

  const listed = choices !== null && choices.length > 0;
  const field = "min-h-11 w-full rounded-lg border bg-background px-3 text-body text-foreground";
  const quiet = "flex min-h-9 items-center justify-center gap-1 rounded-md text-footnote text-muted-foreground hover:text-foreground coarse:min-h-11";
  // One primary at a time: Find, or Connect once a list or the typed ID is open. Next to Connect, a
  // line says linking only brings the history in.
  const connectButton = <>
    <Button size="block" disabled={disabled || busy !== null || !id.trim()} aria-busy={busy === "connect" || undefined} onClick={() => void connect()}>Connect history</Button>
    <p className="text-center text-footnote text-muted-foreground">Messages still go to this terminal.</p>
  </>;
  return <div className="flex w-full flex-col gap-3 text-left">
    {listed
      ? <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={listId} className="text-footnote text-muted-foreground">Running in this folder</label>
          <button type="button" disabled={busy !== null} aria-busy={busy === "find" || undefined} onClick={() => void load()} className={cn(quiet, "-mr-2 px-2 disabled:not-aria-busy:text-disabled-foreground")}>Search again</button>
        </div>
        <SelectField id={listId} aria-label="Conversation to connect" value={id} onChange={(event) => setId(event.target.value)}>
          <option value="">Choose a conversation</option>
          {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.title} ({choice.id.slice(0, 8)})</option>)}
        </SelectField>
      </div>
      : <Button variant={leads && !manual ? "default" : "outline"} size={leads ? "lg" : "default"} className={leads ? "self-center" : "w-full"}
        disabled={busy !== null} aria-busy={busy === "find" || undefined} onClick={() => void load()}>Find Codex conversations</Button>}
    {choices?.length === 0 && <p role="status" className="text-center text-footnote text-muted-foreground">No Codex conversation is running in this folder.</p>}
    {listed && connectButton}
    <button type="button" aria-expanded={manual} aria-controls={regionId} onClick={toggleManual} className={cn(quiet, "w-full")}>
      Enter a session ID
      <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform duration-200 motion-reduce:transition-none", manual && "rotate-180")} />
    </button>
    <div id={regionId} hidden={!manual} className="flex flex-col gap-3">
      <label className="block space-y-1.5 text-footnote text-muted-foreground">
        <span className="block">Session ID, from Codex /status</span>
        <input ref={input} aria-label="Session ID" className={field} value={id} onChange={(event) => setId(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
      </label>
      {!listed && connectButton}
    </div>
    {error && <p role="alert" className="text-center text-footnote text-destructive">{error}</p>}
  </div>;
}
