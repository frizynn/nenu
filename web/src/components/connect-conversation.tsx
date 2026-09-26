import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { connectConversation, fetchConversations } from "@/lib/api";
import { Button } from "@/components/ui/button";

/** Explicit recovery: never choose a conversation just because its directory matches. */
export function ConnectConversation({ paneId, session, disabled, onConnected }: {
  paneId: string; session?: string; disabled: boolean; onConnected(): void;
}) {
  const [choices, setChoices] = useState<Array<{ id: string; title: string }> | null>(null);
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const revalidator = useRevalidator();
  useEffect(() => () => request.current?.abort(), []);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null);
    try { setChoices((await fetchConversations(paneId, session, controller.signal)).conversations); }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load conversations."); }
    finally { inFlight.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  async function connect() {
    if (disabled || inFlight.current || !id.trim()) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await connectConversation(paneId, id.trim(), session);
      if (!result.ok) throw new Error(result.error);
      await revalidator.revalidate();
      onConnected();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not connect conversation."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <div className="w-full max-w-md space-y-3 text-left">
    <p>Select the conversation already running in this terminal. Messages will continue to go to that terminal.</p>
    <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void load()}>Find Codex conversations</Button>
    {choices && <label className="block text-sm">Recent conversations in this directory
      <select aria-label="Conversation to connect" className="mt-1 min-h-11 w-full rounded-md border bg-background px-2" value={id} onChange={(event) => setId(event.target.value)}>
        <option value="">Choose a conversation</option>
        {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.title} ({choice.id.slice(0, 8)})</option>)}
      </select>
    </label>}
    <label className="block text-sm">Session ID from Codex /status
      <input aria-label="Session ID" className="mt-1 min-h-11 w-full rounded-md border bg-background px-2" value={id} onChange={(event) => setId(event.target.value)} autoComplete="off" spellCheck={false} />
    </label>
    <Button className="min-h-11" disabled={disabled || busy || !id.trim()} onClick={() => void connect()}>Connect history</Button>
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
