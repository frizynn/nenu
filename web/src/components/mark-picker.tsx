import { useRef, useState, type RefObject } from "react";

import { errorMessage } from "@/components/node-start";
import { MarkGlyph } from "@/components/project-glyph";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { setCoordinatorMark } from "@/lib/api";
import { COORDINATOR_GLYPHS, coordinatorMark, coordinatorMarks, type Mark } from "@/lib/coordinator-mark";
import { MARK_HUES, type GlyphName } from "@/lib/project-glyph";
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
  const anchor = useRef<HTMLButtonElement>(null);
  const mark = coordinatorMark(project, id);
  const glyph = <MarkGlyph mark={mark} size={Math.round(size * 0.56)} />;
  const style = { width: size, height: size, "--mark": `var(--glyph-${mark.hue})` } as React.CSSProperties;
  if (!editable) return <span aria-hidden className={cn("mark-tile", className)} style={style}>{glyph}</span>;
  return <>
    <button ref={anchor} type="button" className={cn("mark-tile mark-tile-button", className)} style={style}
      aria-label={`Change ${name}'s icon`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      {glyph}
    </button>
    {open && <MarkPicker project={project} id={id} name={name} session={session} anchorRef={anchor}
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
  // A glyph another open coordinator of the project (or the project) draws stays pickable, but says whose it is.
  const used = new Map<GlyphName, string>();
  for (const [other, drawn] of coordinatorMarks(project)) {
    const owner = other === "root" ? project.name : project.threads.find((thread) => thread.id === other && thread.status !== "resolved")?.title;
    if (other !== id && owner && !used.has(drawn.glyph)) used.set(drawn.glyph, owner);
  }
  return (
    <WorkbenchPopover open onDismiss={onDismiss} anchorRef={anchorRef} label={`Icon for ${name}`} phoneBack sheetBelowDesk className="w-80 lg:w-[19rem]">
      <div className="mark-picker">
        <div role="radiogroup" aria-label="Icon" className="mark-picker-glyphs">
          {COORDINATOR_GLYPHS.map((glyph) => (
            <button key={glyph} type="button" role="radio" aria-checked={glyph === mark.glyph} aria-label={used.has(glyph) ? `${glyph}, used by ${used.get(glyph)}` : glyph}
              title={used.has(glyph) ? `Used by ${used.get(glyph)}` : undefined} data-used={used.has(glyph) || undefined}
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
