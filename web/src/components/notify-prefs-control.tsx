import type { ReactNode } from "react";
import { Pending } from "@/components/ui/icon";

import { ListRow, ListSection } from "@/components/ui/list-group";
import { Switch, switchSlot } from "@/components/ui/switch";
import { useNotifyPrefs } from "@/hooks/use-notify-prefs";
import type { NotifyPrefs } from "@/lib/api";

// Which lifecycle events are worth a push. Bridge-wide (fans out to every device, like the snooze),
// so the footer says so, and says where THIS device stands: a blocked phone still sees these rows
// live, because they decide what every other device gets. One switch per kind the bridge tells apart
// (bridge/notify-prefs.ts, ADR 0072): an agent waiting on you, a finish that answers a person, a
// subagent's result (off by default) and updates. Optimistic toggle with revert on failure.

const ROWS: ReadonlyArray<{ key: keyof NotifyPrefs; label: string; hint: string }> = [
  { key: "blocked", label: "Needs input", hint: "Any agent waiting on you." },
  { key: "replies", label: "Replies to you", hint: "An agent finishes what a person asked: from Nenu, or typed into it." },
  { key: "launched", label: "Agents started by an agent", hint: "An agent another agent launched finishes what that agent asked. The launcher is the one waiting." },
  { key: "subagents", label: "Subagent results", hint: "An agent ends a turn its subagent's result started. Usually noise." },
  { key: "updates", label: "App updates", hint: "When a new Nenu version is out." },
]

/** Push on this device: on, off, blocked by the browser, or unavailable here (HTTP, no Push API). */
export type DevicePush = "on" | "off" | "blocked" | "unavailable";

export function NotifyPrefsControl({ thisDevice, children }: { thisDevice?: DevicePush; children?: ReactNode }) {
  const { prefs, loadFailed, busy, toggle } = useNotifyPrefs();
  const footer = (
    <>
      {loadFailed && <span className="text-destructive">Couldn't load these settings.</span>}{" "}
      Applies to every device with push on.{thisDevice ? ` This device: ${thisDevice}.` : ""}
    </>
  );

  return (
    <ListSection title="Notify when" footer={footer}>
      {/* Rendered before `prefs` lands, not after. ROWS is static, so the group's SHAPE is known from
          the first frame — only the switch values are pending. Gating the list on `prefs` grew the
          page a moment after paint and pushed everything under it down. Until the real values
          arrive each row holds a spinner in the switch's slot (an off switch would claim a value the
          bridge never sent), and an empty slot if the load failed, which the footer says. */}
      {ROWS.map((row) => (
        <ListRow key={row.key} title={row.label} hint={row.hint}>
          <div className={switchSlot}>
            {prefs ? (
              <Switch
                checked={prefs[row.key]}
                disabled={busy}
                onCheckedChange={(next) => void toggle(row.key, next)}
                aria-label={row.label}
              />
            ) : (
              !loadFailed && <Pending aria-hidden="true" className="size-4 text-muted-foreground" />
            )}
          </div>
        </ListRow>
      ))}
      {children}
    </ListSection>
  );
}
