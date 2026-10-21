import { useEffect, useRef, useState } from "react";
import { Pencil, CircleX } from "@/components/ui/icon";

import { BottomSheet } from "@/components/ui/sheet";
import { ActionRow, ConfirmView, RenameView } from "@/components/action-sheet-rows";
import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";

interface PaneActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The pane these actions target. Null while nothing is selected (sheet closed). */
  pane: AgentView | null;
  /** What the strip calls the pane, its number included when two share a name: the sheet's title
   *  and its close confirmation say the same. */
  name: string;
  /** Session scope for the rename/close writes (undefined = primary). */
  session?: string;
  /** This device isn't authorised to write — show a read-only note instead of the actions. */
  readOnly?: boolean;
  /** Fired after a successful rename so the parent can revalidate (the label lands on the next poll). */
  onRenamed: () => void;
  /** Fired after a successful close, with the closed pane id — the parent revalidates so it drops out
   *  of the list (and, if it was the pane open, the pane view moves to the one beside it). */
  onClosed: (paneId: string) => void;
}

type Mode = "actions" | "rename" | "confirm";

// Actions for a single pane: rename (set/clear its label) and close (kill). Reached from the open
// pill's chevron, a tap on it or a long-press on any pill. Opens on an action-list view (Rename /
// Close pane); rename is a second tap away so the sheet doesn't shove a keyboard-triggering input at
// you just to close a pane, and Close asks first, saying what stops. The action rows, confirmation
// and rename view are the SHARED pieces (action-sheet-rows) the tab sheet also uses, so the two stay
// identical. The label is user text rendered only into an <input> value / text node — never markup —
// so it stays within the pane-output XSS boundary. Both actions are writes, so under read-only
// they're replaced by a note.
export function PaneActionsSheet({
  open,
  onClose,
  pane,
  name,
  session,
  readOnly = false,
  onRenamed,
  onClosed,
}: PaneActionsSheetProps) {
  const [mode, setMode] = useState<Mode>("actions");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset to the action list — and reprefill the label — whenever the sheet opens on a (new) pane,
  // AND whenever it closes, so reopening never lands you mid-rename. Intentionally NOT keyed on the
  // live label, so a background poll landing while you type can't clobber your edit.
  useEffect(() => {
    setMode("actions");
    if (!open) return;
    setLabel(pane?.paneLabel ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane?.paneId]);

  // Autofocus the label input when rename mode opens, so the phone keyboard pops without a second tap.
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus({ preventScroll: true });
  }, [mode]);

  async function save() {
    if (!pane || saving) return;
    const next = label.trim();
    setSaving(true);
    try {
      const res = await api.renamePane(pane.paneId, next, session);
      if (res.ok) {
        setStatus(next ? "Renamed" : "Label cleared", "success");
        onRenamed();
        onClose();
      } else {
        setStatus(res.error ?? "Rename failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  }

  async function close() {
    if (!pane || closing) return;
    setClosing(true);
    try {
      const res = await api.closePane(pane.paneId, session);
      if (res.ok) {
        onClose();
        onClosed(pane.paneId);
      } else {
        setStatus(res.error ?? "Close failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setClosing(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={name}>
      {readOnly ? (
        <p className="py-2 text-footnote text-muted-foreground">
          Read-only — this device isn't authorised to rename or close panes.
        </p>
      ) : mode === "actions" ? (
        <div className="flex flex-col gap-1">
          <ActionRow
            icon={<Pencil className="size-4 shrink-0 text-muted-foreground" />}
            label="Rename"
            onClick={() => setMode("rename")}
          />
          <ActionRow
            icon={<CircleX className="size-4 shrink-0" />}
            label="Close pane"
            destructive
            onClick={() => setMode("confirm")}
          />
        </div>
      ) : mode === "confirm" ? (
        <ConfirmView
          title={`Close “${name}”?`}
          message={
            pane?.kind === "shell"
              ? "Anything running in this shell stops. This can't be undone."
              : "The agent in this pane stops. This can't be undone."
          }
          confirmLabel="Close pane"
          busy={closing}
          onConfirm={() => void close()}
          onCancel={() => setMode("actions")}
        />
      ) : (
        <RenameView
          inputRef={inputRef}
          title="Rename pane"
          fieldLabel="Pane name"
          label={label}
          onLabelChange={setLabel}
          onSave={() => void save()}
          onCancel={() => setMode("actions")}
          saving={saving}
          // A blank pane field clears the label (blank → null on the bridge), so Save stays enabled.
          canSave={true}
          placeholder="name this pane"
        />
      )}
    </BottomSheet>
  );
}
