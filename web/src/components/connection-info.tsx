import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "@/components/ui/icon";

import { listRowClass, listRowPressable } from "@/components/ui/list-group";
import { cn } from "@/lib/utils";
import type { BridgeStatus, DeviceAuth } from "@/lib/types";

// Read-only diagnostics for Settings: where this client is connected, whether it's a secure context
// (PWA/push need one), the live bridge status, and — when per-device auth is on — this device's
// access level. Reads browser globals (location / isSecureContext); the bridge + device come from the
// polled snapshot (HomeData). Nothing here is configurable; it's for "why isn't X working" triage, so
// it waits behind one closed row instead of taking a screen of every visit.
//
// Renders rows for a list group: the disclosure row, then the diagnostics it opens.
export function ConnectionInfo({
  bridge,
  device,
  build,
}: {
  bridge: BridgeStatus | undefined;
  device: DeviceAuth | undefined;
  /** Build id the bridge serves, as its responses name it (lib/server-build.ts); omitted until one has. */
  build?: string;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const b = bridgeLabel(bridge);
  const d = deviceLabel(device);
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const host = typeof window !== "undefined" ? window.location.host : "—";

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((o) => !o)}
        className={cn(listRowClass, listRowPressable, !open && "rounded-b-xl")}
      >
        <span className="min-w-0 flex-1 text-body">Connection details</span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-subtle-foreground transition-transform duration-120 ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      {/* Collapses on its rows' height (0fr to 1fr), so opening never drops the rows in at once. */}
      <div
        id={regionId}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-180 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <dl className="min-h-0 overflow-hidden">
          <Row label="Endpoint" mono>
            {host}
          </Row>
          <Row label="Secure context">{secure ? "Yes" : "No (plain HTTP)"}</Row>
          <Row label="Bridge">
            <span className={b.tone}>{b.text}</span>
          </Row>
          <Row label="Device access">
            <span className={d.tone}>{d.text}</span>
          </Row>
          {/* Always present, even before the value lands: appearing late moved the rows under it. An
              em dash is a truthful "not known yet" and the same height. */}
          <Row label="Server build" mono>
            {build ?? "—"}
          </Row>
        </dl>
      </div>
    </>
  );
}

function Row({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="relative flex min-h-10 items-center justify-between gap-4 px-4 py-2 text-subhead before:absolute before:top-0 before:right-0 before:left-4 before:h-px before:bg-border">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 truncate text-right", mono && "font-mono text-footnote")}>{children}</dd>
    </div>
  );
}

function bridgeLabel(bridge: BridgeStatus | undefined): { text: string; tone: string } {
  if (bridge === "connected") return { text: "Connected", tone: "text-status-done" };
  if (bridge === "disconnected") return { text: "Herdr offline", tone: "text-status-working" };
  return { text: "Connecting…", tone: "text-muted-foreground" };
}

// Mirrors the deviceAuth matrix on the bridge (see bridge/server.ts). "Local" = an authorised request
// with no device header, i.e. the on-host loopback operator.
function deviceLabel(device: DeviceAuth | undefined): { text: string; tone: string } {
  if (!device || !device.enforced) return { text: "Not enforced", tone: "text-muted-foreground" };
  if (device.authorized) {
    return {
      text: device.device ? `Full access · ${device.device}` : "Full access (local)",
      tone: "text-status-done",
    };
  }
  return {
    text: device.device ? `Read-only · ${device.device}` : "Read-only",
    tone: "text-status-working",
  };
}
