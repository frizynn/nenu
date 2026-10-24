import { useState } from "react";
import { SquareTerminal } from "@/components/ui/icon";

import { SectionLabel } from "@/components/ui/section-label";
import { Chip, ChipStrip } from "@/components/ui/chip";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { displayName } from "@/lib/display-name";
import type { AgentView } from "@/lib/types";

interface PaneStripProps {
  /** The panes that share the current tab (agents + shells), in stable order. */
  panes: AgentView[];
  currentPaneId: string;
  onSelect: (paneId: string) => void;
  /** Session scope for the long-press pane actions (rename/close); undefined = primary. */
  session?: string;
  /** Drop the long-press write actions when the device isn't authorised. */
  readOnly?: boolean;
  /** Revalidate after a rename. Long-press pane actions turn on only when this AND onClosed are set. */
  onRenamed?: () => void;
  /** Refresh after a close (DetailRoute moves off the open pane). Enables long-press with onRenamed. */
  onClosed?: (paneId: string) => void;
}

// The panes within the current tab, as a horizontal switcher one level below the tab bar
// (space › tab › pane). Mobile deliberately doesn't replicate the desktop's pane tiling — a tab can
// hold several panes, and this is just a quick way to flip between them. Rendered only when the tab
// actually holds more than one pane (a lone pane needs no switcher), so it's an optional extra row.
// A long-press on a pill, or a tap on the open one, opens its actions sheet (rename / close) when the
// parent wires the actions.
export function PaneStrip({
  panes,
  currentPaneId,
  onSelect,
  session,
  readOnly,
  onRenamed,
  onClosed,
}: PaneStripProps) {
  // The pane whose actions are open, with the name its pill shows, which the sheet repeats.
  const [sheet, setSheet] = useState<{ pane: AgentView; name: string } | null>(null);
  // Actions need both callbacks wired (revalidate on rename, refresh on close); without them the
  // pills stay plain tap-to-switch — long-press is inert.
  const actionsEnabled = !!onRenamed && !!onClosed;

  if (panes.length < 2) return null;
  const names = chipNames(panes);

  return (
    <>
      <ChipStrip band="panes" activeKey={currentPaneId} lead={<span className="hidden sm:inline"><SectionLabel>Panes</SectionLabel></span>}>
        {panes.map((p) => {
          const { name, tag } = names.get(p.paneId)!;
          const open = () => setSheet({ pane: p, name: tag ? `${name} · ${tag}` : name });
          return (
            <Chip
              key={p.paneId}
              label={name}
              tag={tag}
              active={p.paneId === currentPaneId}
              status={p.kind === "shell" ? undefined : p.status}
              icon={p.kind === "shell" ? <SquareTerminal aria-hidden="true" className="size-3.5 shrink-0" /> : undefined}
              onClick={() => onSelect(p.paneId)}
              onLongPress={actionsEnabled ? open : undefined}
              // A tap on the open pill would be a dead re-navigate; it opens the same sheet instead,
              // except on a read-only device, whose sheet holds only a note.
              onTapActive={actionsEnabled && !readOnly ? open : undefined}
            />
          );
        })}
      </ChipStrip>

      {actionsEnabled && (
        <PaneActionsSheet
          open={sheet !== null}
          onClose={() => setSheet(null)}
          pane={sheet?.pane ?? null}
          name={sheet?.name ?? ""}
          session={session}
          readOnly={readOnly}
          onRenamed={onRenamed}
          onClosed={onClosed}
        />
      )}
    </>
  );
}

/** Each pane's one name, numbered only where two panes in the tab share it ("Codex · 1", "Codex · 2"). */
function chipNames(panes: readonly AgentView[]) {
  const named = panes.map((p) => [p.paneId, displayName(p)] as const);
  const count = new Map<string, number>();
  for (const [, name] of named) count.set(name, (count.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return new Map(
    named.map(([paneId, name]): [string, { name: string; tag?: string }] => {
      if (count.get(name)! < 2) return [paneId, { name }];
      const nth = (seen.get(name) ?? 0) + 1;
      seen.set(name, nth);
      return [paneId, { name, tag: String(nth) }];
    }),
  );
}
