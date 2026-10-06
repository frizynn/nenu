import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

import { ProjectTasks } from "@/components/project-tasks";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { isOpenThread, type PaneProject } from "@/lib/projects";
import { isReadOnly } from "@/lib/types";

/** What a project gives the chat it wraps: a title, a bar under the header, and a replacement body. */
export interface ProjectChatSlots {
  title: string;
  subheader?: ReactNode;
  overlay?: ReactNode;
}

const PANEL_KEY = "nenu:project-panel:v1";

function readPanelPref(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
}

/**
 * A pane that belongs to a project renders inside this frame. Wide screens keep the project's task
 * list beside the chat (collapsible); narrower ones switch between Chat and Tasks in place, keeping
 * the chat mounted so its draft and scroll survive the switch.
 */
export function ProjectFrame({ owner, paneId, data, children }: {
  owner: PaneProject;
  paneId: string;
  data: HomeData;
  children: (slots: ProjectChatSlots) => ReactNode;
}) {
  const { project } = owner;
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const wide = useMediaQuery("(min-width: 1280px)");
  const [panelOpen, setPanelOpenState] = useState(readPanelPref);
  const [view, setView] = useState<"chat" | "tasks">("chat");
  const panelShown = wide && panelOpen;
  // Toggling unmounts the button that was pressed; hand focus to its counterpart.
  const toggleFocus = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (toggled.current) toggleFocus.current?.focus({ preventScroll: true });
    toggled.current = false;
  }, [panelOpen]);

  function setPanelOpen(next: boolean) {
    toggled.current = true;
    setPanelOpenState(next);
    try {
      localStorage.setItem(PANEL_KEY, next ? "open" : "closed");
    } catch {
      // A blocked store only forgets the choice.
    }
  }

  const tasks = (action?: ReactNode) => (
    <ProjectTasks project={project} panes={data.agents} session={data.session} currentPaneId={paneId}
      readOnly={isReadOnly(data.device)} action={action}
      onOpenPane={(id) => { setView("chat"); if (id !== paneId) navigate(panePath(id, data.session)); }}
      onChanged={() => revalidator.revalidate()} />
  );

  const openCount = project.threads.filter(isOpenThread).length;
  const subheader = panelShown ? undefined : wide ? (
    <div className="project-bar">
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{project.goal ?? project.name}</p>
      <button ref={toggleFocus} type="button" className="quiet-action" onClick={() => setPanelOpen(true)}><PanelRightOpen aria-hidden className="size-4" />Project</button>
    </div>
  ) : (
    <div className="project-bar">
      <div role="tablist" aria-label="Project view" className="segmented">
        <button type="button" role="tab" aria-selected={view === "chat"} onClick={() => setView("chat")}>Chat</button>
        <button type="button" role="tab" aria-selected={view === "tasks"} onClick={() => setView("tasks")}>
          Tasks{openCount > 0 && <span className="tabular-nums text-muted-foreground">{openCount}</span>}
        </button>
      </div>
    </div>
  );

  return (
    <div className="project-frame">
      {children({
        title: owner.thread?.title ?? project.name,
        subheader,
        overlay: !panelShown && view === "tasks" ? <div className="project-overlay">{tasks()}</div> : undefined,
      })}
      {panelShown && (
        <aside className="project-panel" aria-label="Project">
          {tasks(
            <button ref={toggleFocus} type="button" className="workbench-icon-button -mt-1.5 -mr-2" aria-label="Hide project panel" onClick={() => setPanelOpen(false)}>
              <PanelRightClose aria-hidden className="size-4" />
            </button>,
          )}
        </aside>
      )}
    </div>
  );
}
