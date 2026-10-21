import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Pencil, CircleX } from "@/components/ui/icon";

import { BottomSheet } from "@/components/ui/sheet";
import { ActionRow, ConfirmView, RenameView } from "@/components/action-sheet-rows";
import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import type { TabView } from "@/lib/types";

interface TabActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The tab these actions target. Null while nothing is selected (sheet closed). */
  tab: TabView | null;
  /** What the strip calls the tab: the sheet's title and its close confirmation say the same. */
  name: string;
  /** Session scope for the rename/close writes (undefined = primary). */
  session?: string;
  /** This device isn't authorised to write — show a read-only note instead of the actions. */
  readOnly?: boolean;
  /** Fired after a successful rename so the parent can revalidate (the label lands on the next poll). */
  onRenamed: () => void;
  /** Fired after a successful close, with the closed tab id — the parent moves off it if it was the
   *  selected/viewed tab, and revalidates so it drops out of the strip. */
  onClosed: (tabId: string) => void;
  /** Move the tab one place along the strip; unset where it can't go (the first has no left). The
   *  way to reorder without dragging, and the one a screen reader or a switch can reach. */
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}

type Mode = "actions" | "rename" | "confirm";

// Actions for a single tab — the SAME structure as the pane sheet (the user asked for them to
// match): opens on an action-list view (Rename / Move left / Move right / Close tab), with rename tucked behind its own tap
// so opening the sheet never shoves a keyboard-triggering input at you, and Close asking first.
// Shares the action rows, confirmation and rename view (action-sheet-rows) with the pane sheet so
// the two can't drift. Two differences from a pane, both live-verified: a tab label can't be cleared
// (herdr stores "" literally and rejects null), so a blank field can't be saved; and closing a tab
// kills EVERY pane inside it, so the confirmation names the blast radius. The label is user text rendered only into an <input> value /
// text node — never markup. Both actions are writes, so under read-only they're replaced by a note.
export function TabActionsSheet({
  open,
  onClose,
  tab,
  name,
  session,
  readOnly = false,
  onRenamed,
  onClosed,
  onMoveLeft,
  onMoveRight,
}: TabActionsSheetProps) {
  const [mode, setMode] = useState<Mode>("actions");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset to the action list — and reprefill the label — whenever the sheet opens on a (new) tab, AND
  // whenever it closes, so reopening never lands you mid-rename. Intentionally NOT keyed on the live
  // label, so a background poll landing while you type can't clobber your edit.
  useEffect(() => {
    setMode("actions");
    if (!open) return;
    setLabel(tab?.label ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab?.tabId]);

  // Autofocus the label input when rename mode opens, so the phone keyboard pops without a second tap.
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus({ preventScroll: true });
  }, [mode]);

  const trimmed = label.trim();

  async function save() {
    if (!tab || saving || !trimmed) return;
    setSaving(true);
    try {
      const res = await api.renameTab(tab.tabId, trimmed, session);
      if (res.ok) {
        setStatus("Renamed", "success");
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
    if (!tab || closing) return;
    setClosing(true);
    try {
      const res = await api.closeTab(tab.tabId, session);
      if (res.ok) {
        onClose();
        onClosed(tab.tabId);
      } else {
        setStatus(res.error ?? "Close failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setClosing(false);
    }
  }

  // Closing a tab kills every pane in it, so the confirmation names the blast radius. The count rides
  // on the tab record (snapshot `pane_count`); with none known it only says it can't be undone.
  const paneCount = tab?.paneCount ?? 0;
  const consequence =
    paneCount > 1
      ? `Its ${paneCount} panes close, and anything running in them stops. This can't be undone.`
      : paneCount === 1
        ? "Its pane closes, and anything running in it stops. This can't be undone."
        : "This can't be undone.";

  return (
    <BottomSheet open={open} onClose={onClose} title={name}>
      {readOnly ? (
        <p className="py-2 text-footnote text-muted-foreground">
          Read-only — this device isn't authorised to rename or close tabs.
        </p>
      ) : mode === "actions" ? (
        <div className="flex flex-col gap-1">
          <ActionRow
            icon={<Pencil className="size-4 shrink-0 text-muted-foreground" />}
            label="Rename"
            onClick={() => setMode("rename")}
          />
          {onMoveLeft && (
            <ActionRow
              icon={<ArrowLeft className="size-4 shrink-0 text-muted-foreground" />}
              label="Move left"
              onClick={() => { onClose(); onMoveLeft(); }}
            />
          )}
          {onMoveRight && (
            <ActionRow
              icon={<ArrowRight className="size-4 shrink-0 text-muted-foreground" />}
              label="Move right"
              onClick={() => { onClose(); onMoveRight(); }}
            />
          )}
          <ActionRow
            icon={<CircleX className="size-4 shrink-0" />}
            label="Close tab"
            destructive
            onClick={() => setMode("confirm")}
          />
        </div>
      ) : mode === "confirm" ? (
        <ConfirmView
          title={`Close “${name}”?`}
          message={consequence}
          confirmLabel="Close tab"
          busy={closing}
          onConfirm={() => void close()}
          onCancel={() => setMode("actions")}
        />
      ) : (
        <RenameView
          inputRef={inputRef}
          title="Rename tab"
          fieldLabel="Tab name"
          label={label}
          onLabelChange={setLabel}
          onSave={() => void save()}
          onCancel={() => setMode("actions")}
          saving={saving}
          // A tab has no "clear" (herdr stores "" literally, rejects null), so a blank field can't be
          // saved — Save disables. This is the one rename difference from a pane.
          canSave={!!trimmed}
          placeholder="name this tab"
        />
      )}
    </BottomSheet>
  );
}
