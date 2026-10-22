import { useState, type RefObject } from "react";

import { errorMessage } from "@/components/node-start";
import { MarkGlyph } from "@/components/project-glyph";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { setCoordinatorMark } from "@/lib/api";
import { coordinatorMark, type Mark } from "@/lib/coordinator-mark";
import { GLYPH_NAMES, MARK_HUES } from "@/lib/project-glyph";
import type { ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A coordinator's mark tile: its glyph on a wash of its hue. Where the operator may pick (a coordinator
 * node, a device that can write), it is a button that opens {@link MarkPicker}; elsewhere it only draws.
 */
export function MarkTile({ project, id, name, size = 32, session, editable, onChanged, className }: {
  project: ProjectView; id: string; name: string; size?: number; session?: string;
  editable: boolean; onChanged: () => void; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const mark = coordinatorMark(project, id);
  const glyph = <MarkGlyph mark={mark} size={Math.round(size * 0.56)} />;
  const style = { width: size, height: size, "--mark": `var(--glyph-${mark.hue})` } as React.CSSProperties;
  if (!editable) return <span aria-hidden className={cn("mark-tile", className)} style={style}>{glyph}</span>;
  return <>
    <button ref={setAnchor} type="button" className={cn("mark-tile mark-tile-button", className)} style={style}
      aria-label={`Change ${name}'s icon`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      {glyph}
    </button>
    {open && <MarkPicker project={project} id={id} name={name} session={session} anchorRef={{ current: anchor }}
      onDismiss={() => setOpen(false)} onChanged={onChanged} />}
  </>;
}

/** Every glyph and every pickable hue, applied on the tap; "Use its own" puts the coordinator's own mark back. */
export function MarkPicker({ project, id, name, session, anchorRef, onDismiss, onChanged }: {
  project: ProjectView; id: string; name: string; session?: string;
  anchorRef: RefObject<HTMLElement | null>; onDismiss: () => void; onChanged: () => void;
}) {
  // The pick and the mark as the operator last tapped them, until the snapshot brings the saved pick back.
  const [shown, setShown] = useState<{ pick: { icon?: string; tone?: string }; mark: Mark }>({ pick: project.marks?.[id] ?? {}, mark: coordinatorMark(project, id) });
  const [error, setError] = useState<string | null>(null);
  const save = async (pick: { icon?: string; tone?: string }, mark: Mark) => {
    const before = shown;
    setShown({ pick, mark });
    setError(null);
    try {
      await setCoordinatorMark({ project: project.slug, id, ...pick }, session);
      onChanged();
    } catch (failure) {
      setShown(before);
      setError(errorMessage(failure));
    }
  };
  const { mark, pick } = shown;
  return (
    <WorkbenchPopover open onDismiss={onDismiss} anchorRef={anchorRef} label={`Icon for ${name}`} phoneBack sheetBelowDesk className="w-80 lg:w-[19rem]">
      <div className="mark-picker">
        <div role="radiogroup" aria-label="Icon" className="mark-picker-glyphs">
          {GLYPH_NAMES.map((glyph) => (
            <button key={glyph} type="button" role="radio" aria-checked={glyph === mark.glyph} aria-label={glyph}
              className="mark-picker-glyph" style={{ "--mark": `var(--glyph-${mark.hue})` } as React.CSSProperties}
              onClick={() => void save({ ...pick, icon: glyph }, { ...mark, glyph })}>
              <MarkGlyph mark={{ glyph, hue: mark.hue }} size={18} />
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label="Colour" className="mark-picker-hues">
          {MARK_HUES.map((hue) => (
            <button key={hue} type="button" role="radio" aria-checked={hue === mark.hue} aria-label={hue}
              className="mark-picker-hue" style={{ "--mark": `var(--glyph-${hue})` } as React.CSSProperties}
              onClick={() => void save({ ...pick, tone: hue }, { ...mark, hue })} />
          ))}
        </div>
        {error && <p role="alert" className="text-footnote text-destructive">{error}</p>}
        {(pick.icon || pick.tone) && <button type="button" className="quiet-action self-start" onClick={() => void save({}, coordinatorMarkWithout(project, id))}>
          Use its own icon
        </button>}
      </div>
    </WorkbenchPopover>
  );
}

/** The mark a coordinator draws with no pick: what "Use its own icon" puts back. */
function coordinatorMarkWithout(project: ProjectView, id: string): Mark {
  const marks = { ...project.marks };
  delete marks[id];
  return coordinatorMark({ ...project, marks }, id);
}
