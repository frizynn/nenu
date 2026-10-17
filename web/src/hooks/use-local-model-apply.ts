import { useCallback, useEffect, useRef } from "react";
import { selectNativeModel } from "@/lib/select-native-model";
import { submitMenuKeys } from "@/lib/menu-action";
import { waitForModelAction } from "@/lib/wait-for-model-action";
import type { PaneReadResponse } from "@/lib/types";

interface Options {
  paneId: string; session?: string; agent?: string; requestedLines: number;
  writable: boolean; modelPresent: boolean;
  openCommand: () => Promise<boolean>;
  onApplied: (pane: PaneReadResponse) => void;
  onReasoning?: (pane: PaneReadResponse) => void;
  onLoaded?: () => void;
}

/** Browsing the list owns no terminal input. A tapped row is the explicit choice that starts a guarded CLI operation. */
export function useLocalModelApply(options: Options) {
  const scope = JSON.stringify([options.paneId, options.session, options.agent]);
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const ownsInput = useRef(false);
  const wasModel = useRef(false);
  useEffect(() => {
    ownsInput.current = false;
    wasModel.current = false;
    pending.current = null;
    return () => controller.current?.abort();
  }, [scope]);

  useEffect(() => {
    if (wasModel.current && !options.modelPresent && !pending.current) ownsInput.current = false;
    wasModel.current = options.modelPresent;
  }, [options.modelPresent]);

  const apply = useCallback((name?: string) => {
    if (pending.current) return pending.current;
    const initial = latest.current;
    const request = new AbortController();
    controller.current = request;
    const canWrite = () => !request.signal.aborted && latest.current.writable &&
      initial.paneId === latest.current.paneId && initial.session === latest.current.session && initial.agent === latest.current.agent;
    const check = () => { if (!canWrite()) throw new Error("Model change cancelled."); };
    const operation = (async () => {
      check();
      ownsInput.current = true;
      if (!initial.modelPresent && !await initial.openCommand()) throw new Error("Could not open the agent's model picker.");
      check();
      if (name === undefined) { initial.onLoaded?.(); return; }
      const target = { paneId: initial.paneId, session: initial.session, agent: initial.agent,
        requestedLines: initial.requestedLines, signal: request.signal, canWrite };
      const selected = await selectNativeModel({ ...target, name });
      check();
      if (!selected.ok) throw new Error(selected.error);
      // Claude explicitly advertises `s` for this session. Never fall back to the default-writing Enter.
      const key = initial.agent === "claude" ? "s" : initial.agent === "codex" ? "Enter" : null;
      const action = selected.block.menu.actions.find((entry) => !entry.cancel && entry.keys.length === 1 && entry.keys[0] === key);
      if (!action) throw new Error("This picker does not offer a supported session model action.");
      const result = await submitMenuKeys({ ...target, detectedRevision: selected.pane.revision,
        menu: selected.block.menu, keys: action.keys, nav: false });
      check();
      if (result.status !== "sent") throw new Error(result.status === "error" ? result.error : "The picker changed. Review your selection and try again.");
      const observed = await waitForModelAction({ ...target, previous: selected.block.menu });
      check();
      if (!observed.ok) throw new Error(observed.error);
      if (observed.kind === "closed") {
        ownsInput.current = false;
        initial.onApplied(observed.pane);
      } else if (initial.agent === "codex" && observed.menu.kind === "reasoning" &&
        observed.block.menu.title === `Select Reasoning Level for ${selected.name}`) {
        initial.onReasoning?.(observed.pane);
      } else throw new Error("The picker changed unexpectedly. Review it before applying the model.");
    })();
    pending.current = operation;
    void operation.finally(() => { if (pending.current === operation) pending.current = null; }).catch(() => {});
    return operation;
  }, []);

  const cancel = useCallback(async () => {
    controller.current?.abort();
    await pending.current?.catch(() => {});
  }, []);
  const released = useCallback(() => { ownsInput.current = false; }, []);
  const inputActive = useCallback(() => ownsInput.current || latest.current.modelPresent, []);
  const load = useCallback(() => apply(), [apply]);
  return { apply, load, cancel, released, inputActive };
}
