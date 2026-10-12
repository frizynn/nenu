import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useRouteLoaderData } from "react-router";

import { AppHeader } from "@/components/app-header";
import { BuildStamp } from "@/components/build-stamp";
import { PageBody } from "@/components/column-page";
import { ConnectionInfo } from "@/components/connection-info";
import { HapticsControl } from "@/components/haptics-control";
import { NotifyPrefsControl, type DevicePush } from "@/components/notify-prefs-control";
import { SnoozeControl } from "@/components/snooze-control";
import { ThemeControl } from "@/components/theme-control";
import { UpdateCheckControl } from "@/components/update-check-control";
import { ListRow, ListSection } from "@/components/ui/list-group";
import { Switch, switchSlot } from "@/components/ui/switch";
import { usePushControl } from "@/hooks/use-push";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath } from "@/lib/nav";
import type { PushAvailability, PushState } from "@/lib/push";
import { useServerBuild } from "@/lib/server-build";
import { useSession } from "@/lib/session";

// Settings, as a grouped list: This device, Notify when, Updates, About. Reachable from
// the home header gear. Lives under the root route, so the snapshot polling/push-setup in RootLayout
// keeps running behind it. Every group's rows are there from the first frame. Footers are not: when
// push state lands on a blocked or unavailable device, "This device" gains its note and the "Notify
// when" footer can take a second line, so the groups under them move down once.
export function SettingsRoute() {
  const session = useSession();
  const { state, busy, setEnabled } = usePushControl();
  const [error, setError] = useState<string | null>(null);

  // Settings lives under the root route, so the live snapshot (bridge + device auth) is right here.
  const root = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  // The build the bridge serves, seen on every poll's header (the Updates card also fills it from
  // /api/config for an older bridge). Undefined while unknown.
  const serverBuild = useServerBuild();

  // "On" = the user hasn't disabled it AND a live subscription exists on this device.
  const on = Boolean(state && !state.userDisabled && state.subscribed);
  const blocked = Boolean(state && state.availability !== "ready");
  // When blocked we can still allow turning OFF a lingering subscription, but never turning ON.
  const toggleDisabled = busy || !state || (blocked && !on);

  async function toggle(next: boolean) {
    setError(null);
    const res = await setEnabled(next);
    if (next && !res.ok) setError(reasonText(res.reason));
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <AppHeader bridge={root?.bridge} error={Boolean(root?.error)} title="Settings" back={{ to: homePath(session), label: "Home" }} />

      {/* One 640px column, centred in the content area on a desk. */}
      <PageBody className="flex flex-col" columnClassName="flex max-w-160 flex-col gap-5">
        {/* What this phone does for you, all kept per device: the theme first (it's the setting
            people come here to change), haptics (renders nothing where vibrate is unsupported, as
            on iOS Safari), and whether push reaches this device. */}
        <ListSection
          title="This device"
          footer={
            error ? (
              <span className="text-destructive">{error}</span>
            ) : state && blocked ? (
              availabilityNote(state.availability)
            ) : undefined
          }
        >
          <div className="p-2">
            <ThemeControl />
          </div>
          <HapticsControl />
          <ListRow title="Push notifications">
            {/* Fixed slot the size of the Switch: the spinner is smaller, so without it the row
                resized when state landed. */}
            <div className={switchSlot}>
              {state ? (
                <Switch checked={on} disabled={toggleDisabled} onCheckedChange={toggle} aria-label="Push notifications" />
              ) : (
                <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
              )}
            </div>
          </ListRow>
        </ListSection>

        {/* Mounted while push state is still UNKNOWN, and only removed once we positively learn the
            bridge has no VAPID keys: gating on `state` truthiness inserted the group one frame late
            and shoved everything below it down. Which events notify, and quiet hours, are
            bridge-wide, so they matter whatever this particular device's push status is. */}
        {state?.availability !== "server-off" && (
          <NotifyPrefsControl thisDevice={state ? devicePush(state, on) : undefined}>
            <SnoozeControl snoozedUntil={root?.snoozedUntil ?? null} />
          </NotifyPrefsControl>
        )}

        <UpdateCheckControl />

        <ListSection title="About" footer={<BuildStamp />}>
          <ConnectionInfo bridge={root?.bridge} device={root?.device} build={serverBuild} />
        </ListSection>
      </PageBody>
    </div>
  );
}

function devicePush(state: PushState, on: boolean): DevicePush {
  if (state.availability === "denied") return "blocked";
  if (state.availability !== "ready") return "unavailable";
  return on ? "on" : "off";
}

const HOME_SCREEN = "Add Nenu to your Home Screen to get notifications.";

function reasonText(reason: PushAvailability | undefined): string {
  switch (reason) {
    case "insecure":
      return "Push needs an HTTPS connection.";
    case "server-off":
      return "Push isn't configured on the bridge (no VAPID keys).";
    case "denied":
      return "Notifications are blocked. Allow them in your browser settings.";
    case "unsupported":
      return "This browser doesn't support push notifications.";
    case "home-screen":
      return HOME_SCREEN;
    default:
      return "Couldn't enable push notifications.";
  }
}

function availabilityNote(a: PushAvailability): string {
  switch (a) {
    case "insecure":
      return "Unavailable over plain HTTP. Serve Nenu over HTTPS to enable push.";
    case "server-off":
      return "The bridge has no VAPID keys configured, so push is off for every device.";
    case "denied":
      return "Blocked. Allow notifications in your browser settings.";
    case "unsupported":
      return "This browser doesn't support push notifications.";
    case "home-screen":
      return HOME_SCREEN;
    case "ready":
      return "";
  }
}
