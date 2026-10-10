import { useState } from "react";
import { Plus } from "lucide-react";

import { Chip } from "@/components/ui/chip";
import { TabActionsSheet } from "@/components/tab-actions-sheet";
import { tabName } from "@/lib/spaces";
import { worstTriage } from "@/lib/triage";
import type { AgentView, TabView } from "@/lib/types";

interface TabStripProps {
  workspaceId: string;
  tabs: TabView[];
  agents: AgentView[];
  /** The tab the open pane sits in. */
  selected: string;
  onSelect: (tabId: string) => void;
  onNewTab: (workspaceId: string) => void;
  /** Session scope for the long-press tab actions (rename/close); undefined = primary. */
  session?: string;
  /** Drop the long-press write actions when the device isn't authorised (the sheet shows a note). */
  readOnly?: boolean;
  /** Revalidate after a rename. Long-press tab actions turn on only when this AND onClosed are set. */
  onRenamed?: () => void;
  /** Refresh/fall back after a close. Enables long-press together with onRenamed. */
  onClosed?: (tabId: string) => void;
}

// The open pane's space as a row of tabs above the conversation: tapping a tab opens one of its
// panes; the trailing + creates a new tab (and opens its fresh shell). The desktop-focused tab gets
// a ring; each tab carries a status dot for the most urgent thing inside it. A long-press on a chip
// opens its actions sheet (rename / close) when the parent wires both onRenamed and onClosed (the +
// never takes long-press).
export function TabStrip({
  workspaceId,
  tabs,
  agents,
  selected,
  onSelect,
  onNewTab,
  session,
  readOnly,
  onRenamed,
  onClosed,
}: TabStripProps) {
  const [sheetTab, setSheetTab] = useState<TabView | null>(null);
  // Actions need both callbacks wired (revalidate on rename, fall back on close); without them the
  // chips stay plain tap-to-switch — long-press is inert.
  const actionsEnabled = !!onRenamed && !!onClosed;

  const wsTabs = tabs.filter((t) => t.workspaceId === workspaceId);
  if (wsTabs.length === 0) return null;

  return (
    <>
      {/* 36px to the eye: the extra 8px of bottom padding overlaps the conversation (negative margin,
          transparent, raised) only to give each tab a 44px touch target. */}
      <div data-workbench-navigation-band="tabs" className="relative z-[1] -mb-2 box-content flex h-9 shrink-0 items-start gap-0.5 overflow-x-auto overflow-y-hidden border-t border-border/40 px-2 pb-2 [scrollbar-width:none] sm:px-4 [&::-webkit-scrollbar]:hidden">
        {wsTabs.map((t, index) => (
          <Chip
            key={t.tabId}
            label={tabName(t.label, index + 1)}
            active={selected === t.tabId}
            ring={t.focused}
            // What's actually going on in there — blocked / ready / working / idle — instead of a
            // dot that only ever appeared for blocked and left every other state unreadable.
            status={worstTriage(agents.filter((a) => a.tabId === t.tabId))}
            onClick={() => onSelect(t.tabId)}
            // Long-press (and a tap on the already-active tab) opens the actions sheet — only when the
            // parent wired the actions; otherwise the chips stay plain tap-to-switch.
            onLongPress={actionsEnabled ? () => setSheetTab(t) : undefined}
            onTapActive={actionsEnabled ? () => setSheetTab(t) : undefined}
          />
        ))}
        <button
          type="button"
          onClick={() => onNewTab(workspaceId)}
          aria-label="New tab"
          className="relative flex h-9 w-11 shrink-0 items-center justify-center text-muted-foreground transition-colors after:absolute after:inset-x-0 after:top-0 after:-bottom-2 after:content-[''] hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {actionsEnabled && (
        <TabActionsSheet
          open={sheetTab !== null}
          onClose={() => setSheetTab(null)}
          tab={sheetTab}
          session={session}
          readOnly={readOnly}
          onRenamed={onRenamed}
          onClosed={onClosed}
        />
      )}
    </>
  );
}
