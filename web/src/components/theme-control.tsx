import { Moon, MonitorSmartphone, Sun } from "@/components/ui/icon";

import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { useTheme } from "@/hooks/use-theme";
import type { Theme } from "@/hooks/use-theme";

// Appearance lives in ONE place: a labelled three-way in Settings. An earlier revision also put a
// cycling icon in every header; it was removed because a control you meet three times per screen
// implies you are meant to keep reaching for it, and this is a set-once preference — System already
// follows the phone, which is the situational flip (outdoors, in bed) happening on its own.

const OPTIONS: ReadonlyArray<SegmentedOption<Theme>> = [
  { value: "system", label: "System", icon: MonitorSmartphone },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function ThemeControl() {
  const { theme, setTheme } = useTheme();
  return <Segmented label="Appearance" options={OPTIONS} value={theme} onChange={setTheme} />;
}
