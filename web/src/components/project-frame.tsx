import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { ListChecks, MessageSquare, PanelRightClose } from "lucide-react";

import { ProjectTasks } from "@/components/project-tasks";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { isOpenThread, type PaneProject } from "@/lib/projects";
import { isReadOnly } from "@/lib/types";

/** What a project gives the chat it wraps: a title, a header control, and a replacement body. */
export interface ProjectChatSlots {
  title: string;
  headerAction?: ReactNode;
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
 * the chat mounted so its draft and scroll survive the switch. The switch is one header button, not a
 * band under the header, so the chat keeps every row of height for writing.
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
  // One button in the header, whichever way the tasks open; it stays the same node, so focus stays.
  const tasksShown = !wide && view === "tasks";
  const headerAction = panelShown ? undefined : (
    <button ref={toggleFocus} type="button" className="project-toggle"
      aria-label={tasksShown ? "Back to chat" : `Tasks, ${openCount} open`}
      onClick={() => (wide ? setPanelOpen(true) : setView(tasksShown ? "chat" : "tasks"))}>
      {tasksShown ? <><MessageSquare aria-hidden className="size-3.5" />Chat</> : <>
        <ListChecks aria-hidden className="size-3.5" />Tasks
        {openCount > 0 && <span className="tabular-nums text-muted-foreground">{openCount}</span>}
      </>}
    </button>
  );

  return (
    <div className="project-frame">
      {children({
        title: owner.thread?.title ?? project.name,
        headerAction,
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
