import { useState } from "react";
import { Plus } from "lucide-react";

import { Chip } from "@/components/ui/chip";
import { SectionLabel } from "@/components/ui/section-label";
import { TabActionsSheet } from "@/components/tab-actions-sheet";
import { worstTriage } from "@/lib/triage";
import type { AgentView, TabView } from "@/lib/types";

interface TabStripProps {
  workspaceId: string;
  tabs: TabView[];
  agents: AgentView[];
  /** Selected tab id, or null for "All" (every tab's panes). */
  selected: string | null;
  onSelect: (tabId: string | null) => void;
  onNewTab: (workspaceId: string) => void;
  /** Show the leading "All" chip (home space view); off for the in-pane tab bar. */
  allowAll?: boolean;
  /** Session scope for the long-press tab actions (rename/close); undefined = primary. */
  session?: string;
  /** Drop the long-press write actions when the device isn't authorised (the sheet shows a note). */
  readOnly?: boolean;
  /** Revalidate after a rename. Long-press tab actions turn on only when this AND onClosed are set. */
  onRenamed?: () => void;
  /** Refresh/fall back after a close. Enables long-press together with onRenamed. */
  onClosed?: (tabId: string) => void;
}

// The selected space's tabs as a horizontal strip — the second header row under SpaceStrip, mirroring
// it one level down. "All" shows every tab's panes; tapping a tab filters the space to it; the
// trailing + creates a new tab (and opens its fresh shell). The desktop-focused tab gets a ring;
// each tab carries a status dot for the most urgent thing inside it. A long-press on a chip opens
// its actions sheet
// (rename / close) when the parent wires both onRenamed and onClosed (the "All" chip and the + never
// take long-press).
export function TabStrip({
  workspaceId,
  tabs,
  agents,
  selected,
  onSelect,
  onNewTab,
  allowAll = true,
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
      {/* shrink-0 for the same reason as SpaceStrip — see the note there. */}
      <div data-workbench-navigation-band="tabs" className={allowAll
        ? "flex min-h-9 shrink-0 items-center gap-1 overflow-x-auto border-t border-border/40 px-2 py-0.5 [scrollbar-width:none] sm:gap-2 sm:px-3 sm:py-2 [&::-webkit-scrollbar]:hidden"
        // 36px to the eye: the extra 8px of bottom padding overlaps the conversation (negative margin,
        // transparent, raised) only to give each tab a 44px touch target.
        : "relative z-[1] -mb-2 box-content flex h-9 shrink-0 items-start gap-0.5 overflow-x-auto overflow-y-hidden border-t border-border/40 px-2 pb-2 [scrollbar-width:none] sm:px-4 [&::-webkit-scrollbar]:hidden"}>
        {allowAll && <span className="hidden sm:inline"><SectionLabel>Tabs</SectionLabel></span>}
        {allowAll && <Chip label="All" active={selected === null} onClick={() => onSelect(null)} />}
        {wsTabs.map((t) => (
          <Chip
            key={t.tabId}
            quiet={!allowAll}
            label={t.label}
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
          className={allowAll
            ? "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent active:scale-95"
            : "relative flex h-9 w-11 shrink-0 items-center justify-center text-muted-foreground transition-colors after:absolute after:inset-x-0 after:top-0 after:-bottom-2 after:content-[''] hover:text-foreground"}
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
