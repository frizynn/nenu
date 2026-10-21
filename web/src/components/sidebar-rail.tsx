import { useEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router";
import { House, LayoutGrid, PanelLeft, Search, Settings2, SquarePen } from "@/components/ui/icon";

import { ProjectGlyph } from "@/components/project-glyph";
import { StatusDot } from "@/components/status-badge";
import { looseWorkspaces } from "@/components/workbench-sidebar";
import { liveliest, projectAgents } from "@/lib/desk-nav";
import { needYou } from "@/lib/home-stats";
import type { HomeData } from "@/lib/loaders";
import { MOTION_CONTROL_MS } from "@/lib/motion";
import { homePath, projectPath, projectsPath, settingsPath, workspacePath } from "@/lib/nav";
import { projectForPane } from "@/lib/projects";
import { workspaceName } from "@/lib/spaces";
import { STATUS_LABEL, type AgentStatus } from "@/lib/types";

/** A name's words as upper-case letters: split at spaces, punctuation and a lower-to-upper case change. */
function words(name: string): string[][] {
  const found = name.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return (found.length ? found : [Array.from(name.trim())[0] ?? "?"]).map((word) => Array.from(word.toUpperCase()));
}

/** A tile's codes, best first: word initials, then a later word's first two letters, then the first word's letters. */
function candidates(name: string): string[] {
  const [first, ...rest] = words(name) as [string[], ...string[][]];
  const lead = first[0]!;
  if (!rest.length) return [first.slice(0, 2).join(""), ...first.slice(2).map((letter) => lead + letter)];
  return [
    ...rest.map((word) => lead + word[0]),
    ...rest.filter((word) => word.length > 1).map((word) => word[0]! + word[1]),
    ...first.slice(1).map((letter) => lead + letter),
  ];
}

/**
 * Two letters per rail tile, none shared: "client-alpha-portal" is CA and "client-bravo-portal" CB.
 * A first choice no other tile wants is kept; tiles that want the same one take it in order, and the
 * later ones move to their next free code, so a tile keeps its letters while the herd stays the same.
 */
export function railMonograms(names: readonly string[]): string[] {
  const choices = names.map(candidates);
  const first = choices.map((list) => list[0]!);
  const shared = (code: string) => first.indexOf(code) !== first.lastIndexOf(code);
  const taken = new Set(first.filter((code) => !shared(code)));
  return choices.map((list, i) => {
    if (!shared(first[i]!)) return first[i]!;
    const lead = Array.from(list[0]!)[0]!;
    let code = list.find((candidate) => !taken.has(candidate));
    for (let n = 2; !code; n++) if (!taken.has(lead + n)) code = lead + n;
    taken.add(code);
    return code;
  });
}

const HUES = [25, 70, 150, 195, 235, 275, 315, 350];

/** A name's tile hue, the same on every load (FNV-1a over the name). */
export function railHue(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193);
  return HUES[(hash >>> 0) % HUES.length]!;
}

/** How long a hover rests before an item's name shows. While one shows, and briefly after, the next one shows at once. */
const TIP_DELAY_MS = 300;
const TIP_WARM_MS = 400;
/** How long a name takes to fade out; it stays mounted until then. Matches the .rail-tip exit in shell.css. */
const TIP_EXIT_MS = MOTION_CONTROL_MS;

/**
 * The name of the rail item under the pointer or keyboard focus, drawn to the rail's right. The rail
 * scrolls, so the label is portalled out of it and placed from the item's box. As WCAG 1.4.13 asks of
 * content shown on hover, the pointer can rest on the label, and Escape closes it wherever focus is.
 */
function useRailTip() {
  const [tip, setTip] = useState<{ label: string; left: number; top: number; leaving?: boolean } | null>(null);
  const shown = useRef<HTMLElement | null>(null);
  const pending = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const exit = useRef<ReturnType<typeof setTimeout>>(undefined);
  const warmUntil = useRef(0);
  // Focus names an item only after a key press, as :focus-visible would: a click already shows it on hover.
  const keyboard = useRef(false);

  const show = (item: HTMLElement) => {
    clearTimeout(timer.current);
    clearTimeout(exit.current);
    pending.current = null;
    shown.current = item;
    const box = item.getBoundingClientRect();
    setTip({ label: item.dataset.railTip ?? "", left: box.right + 8, top: box.top + box.height / 2 });
  };
  const hide = () => {
    clearTimeout(timer.current);
    pending.current = null;
    if (!shown.current) return;
    warmUntil.current = performance.now() + TIP_WARM_MS;
    shown.current = null;
    setTip((last) => last && { ...last, leaving: true });
    exit.current = setTimeout(() => setTip(null), TIP_EXIT_MS);
  };
  const itemOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-rail-tip]") : null);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") hide();
      else if (!event.metaKey && !event.ctrlKey && !event.altKey) keyboard.current = true;
    };
    const onPointer = () => { keyboard.current = false; };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      clearTimeout(timer.current);
      clearTimeout(exit.current);
    };
  }, []);

  const handlers = {
    onPointerOver(event: PointerEvent) {
      if (event.pointerType === "touch") return;
      // On the label itself (it is portalled, but its events still reach the rail): keep it up to be read.
      if (event.target instanceof Element && event.target.closest(".rail-tip")) return void clearTimeout(timer.current);
      const item = itemOf(event.target);
      // Back on the item already named, from the gap: keep its label, cancelling the hide the gap armed.
      if (item && item === shown.current) return void clearTimeout(timer.current);
      if (item && item === pending.current) return;
      clearTimeout(timer.current);
      pending.current = item;
      // Crossing the gap between two items keeps the label up, so it moves instead of fading again.
      if (!item) timer.current = setTimeout(hide, 100);
      else if (shown.current || performance.now() < warmUntil.current) show(item);
      else timer.current = setTimeout(() => show(item), TIP_DELAY_MS);
    },
    onPointerLeave: hide,
    onFocus(event: FocusEvent) {
      const item = itemOf(event.target);
      if (item && keyboard.current) show(item);
    },
    onBlur(event: FocusEvent) {
      if (!itemOf(event.relatedTarget)) hide();
    },
    onScroll: hide,
  };
  const element = tip && createPortal(
    <div role="tooltip" aria-hidden className="rail-tip" data-leaving={tip.leaving || undefined} style={{ left: tip.left, top: tip.top }}>{tip.label}</div>,
    document.body,
  );
  return { handlers, element };
}

interface Tile {
  key: string;
  name: string;
  to: string;
  current: boolean;
  status?: AgentStatus;
}

/** A project draws its own glyph; a loose workspace, which has none, its two letters on its hue. */
function RailTile({ tile, mark }: { tile: Tile; mark: ReactNode }) {
  return (
    <Link className="rail-link hit-area" to={tile.to} data-rail-tip={tile.name} aria-current={tile.current ? "page" : undefined}>
      {mark}
      {tile.status && <StatusDot status={tile.status} className="rail-tile-dot size-2" />}
      <span className="sr-only">{tile.status ? `${tile.name}, ${STATUS_LABEL[tile.status]}` : tile.name}</span>
    </Link>
  );
}

/** The collapsed sidebar: the same actions as icons, then each project's glyph and two letters per loose workspace. */
export function SidebarRail({ data, attention, expandRef, sidebarId, onExpand, onNewChat, onSearch }: {
  data: HomeData;
  attention: number;
  expandRef: RefObject<HTMLButtonElement | null>;
  sidebarId: string;
  onExpand: () => void;
  onNewChat?: () => void;
  onSearch: () => void;
}) {
  const { paneId, projectSlug, spaceId } = useParams();
  const tip = useRailTip();
  const currentProject = projectSlug ?? projectForPane(data.projects, paneId)?.project.slug;
  const currentSpace = spaceId ?? [...data.agents, ...data.shellPanes].find((pane) => pane.paneId === paneId)?.workspaceId;
  const loose = looseWorkspaces(data);
  const projects = (data.projects ?? []).map((project): Tile => ({
    key: project.slug, name: project.name, to: projectPath(project.slug, data.session), current: currentProject === project.slug,
    status: liveliest(projectAgents(project, data.agents, data.projects)),
  }));
  const workspaces = loose.workspaces.map((workspace): Tile => ({
    key: workspace.workspaceId, name: workspaceName(workspace), to: workspacePath(workspace.workspaceId, data, data.session),
    current: currentSpace === workspace.workspaceId, status: liveliest(loose.agents.filter((pane) => pane.workspaceId === workspace.workspaceId)),
  }));
  const monograms = railMonograms(workspaces.map((tile) => tile.name));
  return (
    <nav className="workbench-sidebar-rail" aria-label="Collapsed sidebar" {...tip.handlers}>
      <button ref={expandRef} type="button" className="workbench-expand workbench-icon-button" aria-label="Expand sidebar" data-rail-tip="Expand sidebar"
        aria-expanded="false" aria-controls={sidebarId} onClick={onExpand}>
        <PanelLeft aria-hidden="true" size={16} />
      </button>
      <button type="button" className="workbench-icon-button" aria-label="New chat" data-rail-tip="New chat" onClick={onNewChat} disabled={!onNewChat}><SquarePen aria-hidden size={16} /></button>
      <button type="button" className="workbench-icon-button" aria-label="Search" data-rail-tip="Search" onClick={onSearch}><Search aria-hidden size={16} /></button>
      <Link className="workbench-icon-button rail-attention" to={homePath(data.session)} aria-label={attention ? `Home, ${needYou(attention)}` : "Home"} data-rail-tip="Home">
        <House aria-hidden size={16} />{attention > 0 && <span className="rail-dot" aria-hidden />}
      </Link>
      <Link className="workbench-icon-button" to={projectsPath(data.session)} aria-label="Projects" data-rail-tip="Projects"><LayoutGrid aria-hidden size={16} /></Link>
      <span className="rail-divider" aria-hidden />
      {projects.map((tile, i) => <RailTile key={tile.key} tile={tile} mark={<ProjectGlyph slug={tile.key} pick={data.projects?.[i]} />} />)}
      {projects.length > 0 && workspaces.length > 0 && <span className="rail-divider" aria-hidden />}
      {workspaces.map((tile, i) => <RailTile key={tile.key} tile={tile}
        mark={<span className="rail-tile" style={{ "--rail-hue": railHue(tile.name) } as CSSProperties} aria-hidden>{monograms[i]}</span>} />)}
      <span className="flex-1" />
      <Link className="workbench-icon-button" to={settingsPath(data.session)} aria-label="Settings" data-rail-tip="Settings"><Settings2 aria-hidden size={16} /></Link>
      {tip.element}
    </nav>
  );
}
