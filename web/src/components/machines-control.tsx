import { useEffect, useState } from "react";
import { Pending } from "@/components/ui/icon";

import { listRowClass, ListRow, ListSection } from "@/components/ui/list-group";
import { Switch, switchSlot } from "@/components/ui/switch";
import { getMachineSettings, setMachinesOn, type MachineSettings } from "@/lib/api";
import { MACHINE_STATE_WORD } from "@/lib/machines";

// Settings → other machines (bridge/machines.ts). Bridge-wide, like the notification prefs: turning it
// on makes the bridge reach every machine Herdr has saved, over SSH, through that machine's own Nenu.
// Herdr's list is read when this section mounts, and only then while the setting is off. Optimistic
// toggle, reconciled with the bridge's answer, reverted on failure.
export function MachinesControl({ readOnly = false }: { readOnly?: boolean }) {
  const [settings, setSettings] = useState<MachineSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getMachineSettings().then((s) => alive && setSettings(s), () => alive && setLoadFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(on: boolean) {
    setSettings((prev) => (prev ? { ...prev, on } : prev));
    setBusy(true);
    try {
      setSettings(await setMachinesOn(on));
    } catch {
      setSettings((prev) => (prev ? { ...prev, on: !on } : prev));
    } finally {
      setBusy(false);
    }
  }

  const footer = loadFailed
    ? <span className="text-destructive">Couldn't load Herdr's machines.</span>
    : settings && settings.machines.length === 0
      ? <>Herdr has no other machine saved. Add one on this machine with <code>herdr machine add &lt;ssh-target&gt;</code>.</>
      : "Applies to every device. Each machine runs its own Nenu, reached over SSH as Herdr reaches it.";

  return (
    <ListSection title="Machines" footer={footer}>
      <ListRow title="Show other machines" hint="Their chats in Home, the sidebar and Search, and New chat on any of them.">
        <div className={switchSlot}>
          {settings ? (
            <Switch checked={settings.on} disabled={busy || readOnly} onCheckedChange={(on) => void toggle(on)} aria-label="Show other machines" />
          ) : (
            !loadFailed && <Pending aria-hidden="true" className="size-4 text-muted-foreground" />
          )}
        </div>
      </ListRow>
      {settings && settings.machines.length > 0 && (
        <ul aria-label="Machines in Herdr" className="contents">
          {settings.machines.map((machine) => (
            <li key={machine.label} className={listRowClass}>
              {/* The name always shows: a long reason (ssh's own words) wraps under it, never over it. */}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body">{machine.label}</span>
                {machine.detail && machine.detail !== MACHINE_STATE_WORD[machine.state] && <span className="block text-footnote text-pretty text-muted-foreground">{machine.detail}</span>}
              </span>
              <span className="shrink-0 text-footnote text-muted-foreground">{MACHINE_STATE_WORD[machine.state]}</span>
            </li>
          ))}
        </ul>
      )}
    </ListSection>
  );
}
