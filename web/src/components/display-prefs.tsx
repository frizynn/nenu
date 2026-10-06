import type { ReactNode } from "react";
import { AArrowDown, AArrowUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import { FONT_MAX, FONT_MIN } from "@/hooks/use-display-prefs";

// The mirror's display prefs, as LABELLED rows behind the header menu's "Display" row.
//
// These used to be a permanent icon-only "View" row above the composer — five 28px glyphs that
// cost a whole row of a phone viewport for settings you touch once and then never again. Behind the
// menu each persistent mirror preference gets a real name and explanation. The workbench/terminal
// escape hatch lives in the header, where it is reachable without opening another panel.
//
// It rides the same in-flow ComposerDock as Keys/Quick rather than a covering sheet, deliberately:
// every control here changes how the mirror LOOKS, so you have to be able to see the mirror while
// you flip it.

interface DisplayPrefsContentProps {
  prefs: DisplayPrefs;
  setWrap: (wrap: boolean) => void;
  stepFontSize: (delta: number) => void;
  setTapToFocus: (tapToFocus: boolean) => void;
}

// One settings row: name (+ optional explanation) on the left, control on the right. Module-level so
// it isn't a fresh component type each render.
function Row({
  label,
  hint,
  htmlFor,
  control,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-medium">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function DisplayPrefsContent({
  prefs,
  setWrap,
  stepFontSize,
  setTapToFocus,
}: DisplayPrefsContentProps) {
  return (
    <div className="divide-y divide-border/60 border-t border-border/60 bg-muted/30 px-3 py-1">
      <Row
        label="Wrap lines"
        hint="Off shows column-faithful output for TUI tables — you pan instead."
        htmlFor="pref-wrap"
        control={
          <Switch
            id="pref-wrap"
            checked={prefs.wrap}
            onCheckedChange={setWrap}
            aria-label="Wrap lines"
          />
        }
      />
      <Row
        label="Tap to type"
        hint="On, tapping the mirror anywhere opens the keyboard. Off, the mirror behaves like a document — taps land on the text and only the composer opens the keyboard."
        htmlFor="pref-tap-to-focus"
        control={
          <Switch
            id="pref-tap-to-focus"
            checked={prefs.tapToFocus}
            onCheckedChange={setTapToFocus}
            aria-label="Tap to type"
          />
        }
      />
      <Row
        label="Text size"
        control={
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-9"
              disabled={prefs.fontSize <= FONT_MIN}
              onClick={() => stepFontSize(-1)}
              aria-label="Decrease font size"
            >
              <AArrowDown className="size-4" />
            </Button>
            <span className="w-8 text-center font-mono text-xs tabular-nums text-muted-foreground">
              {prefs.fontSize}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-9"
              disabled={prefs.fontSize >= FONT_MAX}
              onClick={() => stepFontSize(1)}
              aria-label="Increase font size"
            >
              <AArrowUp className="size-4" />
            </Button>
          </div>
        }
      />
    </div>
  );
}
