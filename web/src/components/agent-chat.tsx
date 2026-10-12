import { QuestionLiveContext, QuestionReplyContext } from "./transcript-question";
import { lockReasonOf, QuestionCard } from "@/components/question-card";
import { useInteractions } from "@/hooks/use-interactions";
import { agentBusy, turnNote, turnRunning } from "@/lib/turn";
import { useHoldReload } from "@/lib/reload-guard";
import { SubagentConversation, SubagentSubtitle } from "@/components/subagent-conversation";
import { useSubagents, type SubagentSelection } from "@/hooks/use-subagents";
import { useActivity, useActivityClock } from "@/hooks/use-activity";
import { buildProcesses } from "@/lib/processes";
import { detailTitle, ProcessDetailView, ProcessesChip, ProcessesList, ProcessPanel, type ProcessDetail } from "@/components/activity/processes";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { AppWindow, ArrowUpToLine, ChevronDown, ChevronUp, Hourglass, Keyboard, Loader2, MessageSquareText, Paperclip, PanelTop, ScrollText, Search, TerminalSquare } from "lucide-react";
import { NEUTRAL_ACTION, PRIMARY_ACTION } from "@/components/option-button";
import { agentName } from "@/hooks/use-message-queue";
import { StartAgent } from "@/components/start-agent";
import { SpawnStatus } from "@/components/spawn-status";
import { openNewAgent, useSpawnState } from "@/lib/spawn";
import { useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useStableTerminalDraft } from "@/hooks/use-terminal-draft";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { isConnecting } from "@/lib/connection";
import { setStatus } from "@/lib/status";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { ConversationActions, type ConversationAction } from "@/components/conversation-actions";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useKeyboardOpen } from "@/hooks/use-keyboard";
import { AppHeader, type HeaderBack } from "@/components/app-header";
import { ChatFilesBrowser } from "@/components/chat-files-browser";
import { AnsiOutput } from "@/components/ansi-output";
import { AgentsFooter } from "@/components/agents-footer";
import { MIRROR_SPACE, MIRROR_INVERT, styleFor } from "@/components/mirror-space";
import { cn } from "@/lib/utils";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { adapterFor } from "@/lib/harness";
import { blockOwnsKeyboard } from "@/lib/harness/dialog-contract";
import { terminalWait } from "@/lib/terminal-wait";
import { FindBar, thirdScrollTop } from "@/components/find-bar";
import { PaneGone } from "@/components/pane-gone";
import { Composer, type ComposerControl, type ComposerHandle } from "@/components/composer";
import { ConnectConversation } from "@/components/connect-conversation";
import { LiveConversation } from "@/components/live-conversation";
import { PaneCwdContext } from "@/components/work-log-tools";
import { WorkbenchTelemetry } from "@/components/workbench-telemetry";
import { useLiveConversation } from "@/hooks/use-live-conversation";
import { useModelMenuSource } from "@/hooks/use-model-menu-source";
import { useModelCatalog } from "@/hooks/use-model-catalog";
import { useLocalModelApply } from "@/hooks/use-local-model-apply";
import { WorkbenchModelPanel } from "@/components/workbench-model-panel";
import { useWorkbenchPanels } from "@/hooks/use-workbench-panels";
import { parseNativeModelMenu } from "@/lib/native-model-menu";
import { dismissModelPicker } from "@/lib/dismiss-model-picker";
import { waitForModelAction } from "@/lib/wait-for-model-action";
import { commandsFor } from "@/lib/agent-commands";
import { useOperatorCommands } from "@/lib/operator-config";
import { TabStrip } from "@/components/tab-strip";
import { PaneStrip } from "@/components/pane-strip";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { TabActionsSheet } from "@/components/tab-actions-sheet";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { StatusDot } from "@/components/status-badge";
import { submitPromptFeedback, submitPromptOption } from "@/lib/prompt-action";
import { submitWizardKeys } from "@/lib/wizard-action";
import { submitPreviewChoice, submitPreviewKeys, submitPreviewNote, submitPreviewPoint } from "@/lib/preview-action";
import { submitMultiSelectIntent, type MultiSelectIntent } from "@/lib/multi-select-action";
import { submitMenuKeys } from "@/lib/menu-action";
import type { PromptBlockAction } from "@/components/prompt-select-block";
import type { PreviewBlockAction } from "@/components/preview-select-block";
import { type MenuBlockAction } from "@/components/menu-block";
import { canGrowRequestedLines, growRequestedLines } from "@/lib/loaders";
import { shortCwd } from "@/lib/format";
import { displayName, displayPlace } from "@/lib/display-name";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";
import { setMirrorShown } from "@/lib/live-events";
import { historyPath, nodePath, panePath, projectPath } from "@/lib/nav";
import { projectForPane } from "@/lib/projects";
import { paneInTab, tabName } from "@/lib/spaces";
import { isReadOnly, STATUS_LABEL } from "@/lib/types";
import type { AgentView, BridgeStatus, DeviceAuth, ProjectThreadView, ProjectView, TabView, PaneReadResponse } from "@/lib/types";
import type {
  MenuModel,
  MultiSelectModel,
  PreviewSelectModel,
  PromptModel,
  WizardModel,
} from "@/lib/blocks";

/** The chat title's box, whether it opens the navigation, the project's page or nothing. */
const TITLE_SHAPE = "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left pointer-coarse:select-none lg:-mx-1 lg:min-h-9";

/**
 * Where a project thread's back leads, one level up as its node page's does: the coordinator it runs
 * under (its chat while that runs, else its page), else its project. The project's own coordinator
 * has none: the project opens on it, so its back stays Home.
 */
function threadBack(projects: readonly ProjectView[] | undefined, paneId: string, panes: readonly AgentView[], session?: string): HeaderBack | undefined {
  const owner = projectForPane(projects, paneId);
  if (!owner?.thread) return undefined;
  const { project, thread } = owner;
  const parent = project.threads.find((candidate) => candidate.id === thread.parentId);
  if (!parent) return { label: project.name, to: projectPath(project.slug, session) };
  const chat = parent.paneId !== undefined && panes.some((pane) => pane.paneId === parent.paneId) ? parent.paneId : undefined;
  return { label: parent.title, to: chat ? panePath(chat, session) : nodePath(project.slug, parent.id, session) };
}

/** A worker thread takes steering; a coordinator takes questions and new work. */
const COMPOSER_PLACEHOLDER: Record<ProjectThreadView["role"], string> = {
  worker: "Steer this thread…",
  coordinator: "Ask the coordinator…",
};

interface AgentChatProps {
  paneId: string;
  /** The session this pane lives in (undefined = primary) — scopes every read/write + the safety chip. */
  session?: string;
  agent: AgentView | undefined;
  /** Once the pane is gone: the pane as it was last listed (it closed under this page), and the one
   *  beside it, which the closed view opens. */
  closed?: AgentView;
  next?: AgentView;
  agents: AgentView[];
  shellPanes: AgentView[];
  tabs: TabView[];
  /** The herd's projects, so the title and the pane strip name a project's thread as every row does. */
  projects?: readonly ProjectView[];
  /** Owning project, when this pane is one of its coordinator/agent threads; `role` picks the composer copy. */
  project?: { slug: string; name: string; role: ProjectThreadView["role"] };
  /** Header title override; a project frame names the thread this pane runs. */
  title?: string;
  /** A control at the head of the header's right cluster (a project's Tasks toggle). */
  headerAction?: ReactNode;
  /** Replaces the conversation body while set; the chat stays mounted underneath. */
  overlay?: ReactNode;
  /** Rendered under the newest turn of the conversation (a coordinator's thread cards). */
  conversationFooter?: ReactNode;
  /** Replaces the workspace tab strip under the header when defined (a project's thread chips). */
  strip?: ReactNode;
  /** A band right above the composer (a thread's pull request). */
  composerTop?: ReactNode;
  /** Shown beside another pane instead of as the route: its own compact header, and its mirror is
   *  watched through `onMirrorShown` rather than the route's flag. */
  docked?: DockedChat;
  nativeTelemetry?: PaneReadResponse["nativeTelemetry"];
  /** Pane output from the route loader (refreshed by polling/revalidation). */
  text: string;
  /** The pane's first read is still on its way; `text` is what the page had before it. */
  pending?: boolean;
  /** The scrollback window `text` was fetched with — tells a grown fetch from a stale in-flight poll. */
  requestedLines?: number;
  /** The pane's `revision` for `text` — the race guard checks a tapped menu against this. */
  revision?: number;
  /** Per-device auth from the snapshot; an unauthorised device drops the composer to read-only. */
  device?: DeviceAuth;
  // Global connection state — fed straight to the shared AppHeader, which drives the header Nenu
  // mark (gallop/rest, identically to the dashboard), and lets us dim the stale status dot while not
  // live. Defaults describe a healthy link so tests that don't care render "live".
  bridge?: BridgeStatus | undefined;
  error?: boolean;
  authError?: boolean;
  onBack: () => void;
  onSelect: (paneId: string) => void;
}

export interface DockedHeaderView {
  terminal: boolean;
  canToggle: boolean;
  setTerminal: (terminal: boolean) => void;
  find?: ReactNode;
  menu?: ReactNode;
}

export interface DockedChat {
  /** `find` is the find bar while searching; `menu` holds the chat's files and ⋯ actions. */
  header: (view: DockedHeaderView) => ReactNode;
  onMirrorShown: (shown: boolean) => void;
}

// The detail view mirrors a terminal pane, NOT a chat thread. The pane's output comes from the
// route loader (`text`); polling revalidates it. Replies/keys are confirmed via the header status
// line (`setStatus`), then a revalidation pulls the fresh output.
//
// This shell owns the pane frame: the chrome (header, strips; the find bar takes the header over while
// find is open), the terminal mirror (freeze, find highlighting, load-older scrollback), and the way
// back. The composer cluster — draft, send, keys, quick actions, slash-commands, image upload and
// display prefs — lives in <Composer>; it reaches back here only to re-follow the tail after a send,
// focus on a mirror tap, and hand over its view controls for the ⋯ menu.
export function AgentChat({
  paneId,
  session,
  agent,
  closed,
  next,
  agents,
  shellPanes,
  tabs,
  projects,
  project,
  title: titleOverride,
  headerAction,
  overlay,
  conversationFooter,
  strip,
  composerTop,
  docked,
  text,
  pending = false,
  nativeTelemetry,
  requestedLines = 0,
  revision = 0,
  device,
  bridge = "connected",
  error = false,
  authError = false,
  onBack,
  onSelect,
}: AgentChatProps) {
  useHoldReload(docked ? "docked-agent-session" : "open-agent-session", true);
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  // Poll-truth "is the data on screen not live". The header (AppHeader) reads the same inputs to drive
  // the Nenu mark + pill; here we use it to dim the title's status dot, so it stops presenting the
  // last snapshot's status as current while we're reconnecting/lost, and restores instantly on recovery.
  const connecting = isConnecting({ bridge, error });
  const lost = useConnectionLost(connecting);
  const unavailable = bridge !== "connected" || lost;
  const spawning = useSpawnState(paneId);
  // Single display-prefs instance: the View controls (in <Composer>) write it, the mirror reads it.
  const displayScope = JSON.stringify([session ?? "default", paneId]);
  const { prefs, setWrap, stepFontSize, setRawTerminal, setTapToFocus } = useDisplayPrefs(displayScope);
  // Raw-terminal escape hatch: when on, every Claude grammar is bypassed and the plain mirror shows,
  // so a mis-detected/mis-rendered dialog can always be driven by hand with the keys pad.
  const grammarsOn = !prefs.rawTerminal;
  const isShell = agent?.kind === "shell";
  // This device isn't allowlisted to type into agents, or a proxy refused this session: the backend
  // rejects every write, so the composer drops to read-only. The mirror still polls (reading is fine).
  const readOnly = authError || isReadOnly(device);
  // Why writing is paused, in the words the question card uses too: a refused sign-in is not a device
  // that was never authorised, and a silent Herdr is not a lost network. A refusal counts even while
  // the snapshot answers: DetailRoute passes the pane's own refused read as authError.
  const lock = authError && !isReadOnly(device) ? "refused" : lockReasonOf({ readOnly: isReadOnly(device), error, authError, bridge });
  const refusedWrite = lock === "refused" ? "Access refused. Sign in again." : "Read-only — device not authorised";

  const listRef = useRef<ChatMessageListHandle>(null);
  const composerRef = useRef<ComposerHandle>(null);
  // The header keeps one ⋯ on a phone; a desktop also shows the terminal switch.
  const desktop = useMediaQuery("(min-width: 1024px)");
  // While a phone keyboard is up, the tab and pane strips step aside so the chat keeps the height.
  const keyboardOpen = useKeyboardOpen();
  const [composerControls, setComposerControls] = useState<ComposerControl[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [processesOpen, setProcessesOpen] = useState(false);
  const [processDetail, setProcessDetail] = useState<ProcessDetail | null>(null);
  useEffect(() => { setProcessesOpen(false); setProcessDetail(null); }, [displayScope]);
  const [followKey, setFollowKey] = useState(0);
  const [historyRequest, setHistoryRequest] = useState(0);
  const [subagent, setSubagent] = useState<SubagentSelection | null>(null);
  useEffect(() => setSubagent(null), [displayScope, agent?.agent]);
  // A message for a subagent goes through Main: its draft lands in Main's composer once that is back on screen.
  const [forward, setForward] = useState<string | null>(null);
  useEffect(() => {
    if (subagent || forward === null) return;
    composerRef.current?.prepareAnswer(forward);
    setForward(null);
  }, [subagent, forward]);
  const selectSubagent = useCallback((next: SubagentSelection | null) => {
    setSubagent(next);
    if (next) setRawTerminal(false);
  }, [setRawTerminal]);
  const conversation = useLiveConversation({
    paneId, session, enabled: !isShell && Boolean(adapterFor(agent?.agent)), paused: prefs.rawTerminal || Boolean(subagent), busy: agent?.status === "working",
  });
  const hasConversation = Boolean(agent?.hasSession || conversation.history?.available);
  const operatorCommands = useOperatorCommands();
  const modelAvailable = commandsFor(agent?.agent, operatorCommands).some((c) => c.command === "/model" && !c.dangerous);

  const gone = !agent;

  // Mirror freeze: at the bottom we follow live output; the moment you scroll up to read backscroll
  // we hold the text steady (no reflow / no re-pin) until you jump back to latest — so a long
  // message stays put long enough to read instead of sliding out of the rolling window.
  //
  // The frozen snapshot is a {text, revision} PAIR captured at the same instant: the prompt-select
  // race guard must check a tap against the revision of what the user is LOOKING AT. The live
  // `revision` prop keeps advancing with background polls while the mirror is frozen — comparing
  // against it would blind the guard to drift that happened before the freeze (live-vs-live always
  // matches). While following, the frozen pair IS the live pair by definition.
  const [following, setFollowing] = useState(true);
  const [shown, setShown] = useState({ text, revision });
  useEffect(() => {
    if (!following) return;
    // Functional update that returns the previous object when nothing changed keeps React's
    // Object.is bailout — no re-render per poll while the pane is quiet.
    setShown((prev) =>
      prev.text === text && prev.revision === revision ? prev : { text, revision },
    );
  }, [text, revision, following]);
  const display = shown.text;
  const hasNew = !following && display !== text;

  // The agent's own statusline (model · ctx% · cwd · branch · tokens · permission mode) is stripped
  // off the mirror by stripChrome so it doesn't duplicate the composer — but it carries real context
  // (the branch, most notably), so we re-surface it as app chrome just above the composer, where it
  // sat in the TUI. ALL its rows: a configured statusline is routinely 2–3 rows tall, and we used to
  // surface only the first, silently losing the rest. Routed through the SAME adapter (adapterFor)
  // whose buildBlocks strips the chrome, so the two can't drift; empty when there's no adapter for
  // the agent, a menu is up, or no box at the tail, in which case the strip is hidden. A second parse
  // of `display`, but memoised on it, so it only recomputes when the buffer content changes — off the
  // render hot path.
  const statusLines = useMemo(
    () =>
      grammarsOn ? adapterFor(agent?.agent)?.extractStatusLines(splitLines(parseAnsi(display))) ?? [] : [],
    [display, agent?.agent, grammarsOn],
  );

  // The background-agents block the harness paints under its statusline (issue #242). stripChrome
  // peels it off the mirror with the box, and the strip stops above it, so this is its one surface.
  // Same adapter and same parse source as the strip, so the two cannot disagree on where it starts.
  const agentsFooter = useMemo(
    () =>
      grammarsOn
        ? adapterFor(agent?.agent)?.extractAgentsFooter?.(splitLines(parseAnsi(display))) ?? []
        : [],
    [display, agent?.agent, grammarsOn],
  );

  // A user draft stranded on the input box's "❯" line — a message queued while the agent was busy
  // then recalled, which persists across turns. stripChrome peels the box off the mirror so it goes
  // invisible, and (worse) pane.send_text appends to it, corrupting the next send. We surface it to
  // the composer as a read-only preview the user can deliberately Take over — the input is otherwise
  // exclusively phone-owned. Same parse source + same adapter as the statusline, so the two can't
  // drift; null when raw-terminal is on, there's no adapter, no box is at the tail, or the line is empty.
  const modelSource = useModelMenuSource({ paneId, session, agent: agent?.agent, requestedLines, text, revision });
  const inputLines = useMemo(() => splitLines(parseAnsi(modelSource.text)), [modelSource.text]);
  // A pane opened on the page's last text (`pending`) offers no draft: that line may be long gone, so
  // only the fresh read can put one up for Take over.
  const rawTerminalDraft = useMemo(
    () =>
      grammarsOn && !pending
        ? adapterFor(agent?.agent)?.extractInputDraft(inputLines) ?? null
        : null,
    [inputLines, agent?.agent, grammarsOn, pending],
  );
  // Is a dialog (prompt/wizard/preview/multi-select) on screen right now? Any non-raw block means
  // the TUI's keyboard belongs to it, so the composer must refuse a free-text send: the text would
  // be swallowed and the submit key would answer the dialog (#34). Same parse source and adapter as
  // the two probes above, so the three can't drift. This is the zero-latency fail-fast; the
  // load-bearing protection is the bridge send's verify-before-submit, which also covers a dialog that
  // appears after this render.
  const liveBlocks = useMemo(
    () => grammarsOn ? adapterFor(agent?.agent)?.buildBlocks(inputLines) ?? [] : [],
    [inputLines, agent?.agent, grammarsOn],
  );
  // "Owns the keyboard" is asked of the dialog contract, not spelled as `kind !== "raw"`: the
  // slash-command `autocomplete` popup is a non-raw block painted while the input box is live.
  // A key hint on a screen no grammar claims. Only an unexplained one blocks the composer as a dialog;
  // a pause the agent leaves by itself (Claude's usage limit) is a quiet line, and the send guard
  // still refuses the box underneath it either way.
  const wait = grammarsOn && adapterFor(agent?.agent)?.composerReady?.(inputLines) === false && !liveBlocks.some(blockOwnsKeyboard)
    ? terminalWait(modelSource.text)
    : null;
  const unknownInteraction = wait?.kind === "interaction";
  const waitNotice = wait?.kind === "notice" ? wait.text : null;
  const dialogPresent = liveBlocks.some(blockOwnsKeyboard) || unknownInteraction;
  const modelPresent = liveBlocks.some((block) => block.kind === "menu" && parseNativeModelMenu(block.menu, block.lines));
  const liveModelBlock = liveBlocks.find((block) => block.kind === "menu");
  const catalog = useModelCatalog({ paneId, session, agent: agent?.agent, live: liveModelBlock,
    enabled: hasConversation && !isShell && !gone && !connecting });
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const writableRef = useRef(false);
  writableRef.current = !readOnly && !gone && !connecting;
  const localModel = useLocalModelApply({ paneId, session, agent: agent?.agent, requestedLines,
    writable: writableRef.current, modelPresent,
    openCommand: async () => await composerRef.current?.openModelPicker() ?? false,
    onLoaded: () => { void modelSource.refresh(); revalidator.revalidate(); },
    onApplied: (pane) => {
      modelSource.observe(pane);
      setStatus("Model settings applied", "success");
      revalidator.revalidate();
      panels.modelCompleted();
    },
    onReasoning: (pane) => {
      modelSource.observe(pane);
      setStatus("Choose reasoning, then apply the change", "info");
      revalidator.revalidate();
    },
  });
  const panels = useWorkbenchPanels({
    scope: JSON.stringify([paneId, session]), modelPresent,
    otherDialogPresent: dialogPresent && !modelPresent, writable: writableRef.current,
    // Browsing is local. The agent is contacted only by the explicit Use model action.
    openModel: async () => true,
    modelInputActive: localModel.inputActive,
    beforeDismissModel: localModel.cancel,
    dismissModel: async (signal) => {
      modelSource.clear();
      const result = await dismissModelPicker({ paneId, session, agent: agent?.agent, requestedLines,
        signal, canWrite: () => writableRef.current });
      if (result.ok) localModel.released();
      if (!signal.aborted) revalidator.revalidate();
      return result;
    },
    onError: (message) => setStatus(message, "error"),
  });
  useEffect(() => {
    if (agent?.hasSession && dialogPresent) {
      setFollowing(true);
      setShown({ text, revision });
    }
  }, [dialogPresent, text, revision, agent?.hasSession]);
  // Approvals and native pickers own the terminal keyboard. Bring their verified controls into
  // view even while the journal is selected; transcript text never impersonates an approval UI.
  // Herdr can classify a shell as Codex one poll before the SessionStart hook supplies a journal id
  // (and sometimes before its status leaves `unknown`). Treat the harness classification itself as
  // enough to mount the workbench; otherwise a newly launched Codex stays in the raw terminal until
  // a later navigation remounts this view.
  const conversationCapable = !isShell && Boolean(adapterFor(agent?.agent)) &&
    Boolean(
      agent?.agent === "codex" || (agent?.agent === "claude" && agent.status === "unknown") ||
      agent?.hasSession ||
      agent?.status === "idle" ||
      agent?.status === "working"
    );
  const showConversation = conversationCapable && !prefs.rawTerminal;
  // The bridge's reading of this pane's dialog (ADR 0057). The card answers every dialog it can; a
  // preview (its side panel and notes) and a generic menu (its arrows) keep their grammar's full
  // controls, drawn in the card's place (`dialogInline`), and the terminal keeps everything.
  const interactions = useInteractions(session, showConversation && !gone);
  const interaction = interactions.interactions.find((i) => i.paneId === paneId);
  const receipt = interactions.receipts.find((r) => r.paneId === paneId);
  const cardCovers = interaction !== undefined && interaction.kind !== "menu" && !liveBlocks.some((b) => b.kind === "preview-select");
  const showCard = !subagent && showConversation && !modelPresent && (cardCovers || (!interaction && receipt !== undefined));
  const cardReadOnly = readOnly || gone || connecting;
  const refused = interaction && interactions.refusalFor(interaction);
  const { answer } = interactions;
  const { revalidate } = revalidator;
  const refreshConversation = conversation.refresh;
  // The question is the thread's newest line, so it lives inside the conversation's scroller: a swipe
  // over it scrolls the thread, and following lands on its first line (`data-follow-stop`).
  const threadFooter = useMemo(() => !showCard ? conversationFooter : <>
    {conversationFooter}
    <div data-follow-stop className="chat-follow-stop mt-5">
      <QuestionCard key={interaction?.signature ?? "receipt"} interaction={cardCovers ? interaction : undefined} receipt={receipt}
        readOnly={cardReadOnly} lockReason={lock} refused={refused} onOpen={() => setRawTerminal(true)}
        onKeys={() => { setRawTerminal(true); composerRef.current?.openDock("keys"); }}
        onAnswer={async (option, extra) => {
          const outcome = await answer(interaction!, option, extra);
          if (outcome.ok) {
            setFollowing(true);
            revalidate();
            refreshConversation();
          }
          return outcome;
        }} />
    </div>
  </>, [showCard, conversationFooter, interaction, cardCovers, receipt, cardReadOnly, lock, refused, setRawTerminal, answer, revalidate, refreshConversation]);
  // The mirror's poll may relax only while neither the mirror nor a dialog drawn from it is on screen
  // (lib/live-events.ts). Leaving the pane restores the default.
  const mirrorShown = !showConversation || dialogPresent;
  const onDockedMirror = docked?.onMirrorShown;
  useEffect(() => {
    if (onDockedMirror) return onDockedMirror(mirrorShown);
    setMirrorShown(mirrorShown);
    return () => setMirrorShown(true);
  }, [mirrorShown, onDockedMirror]);

  // Both are threaded to the composer: the RAW value (live) plus a stabilised one. extractInputDraft
  // is stateless, so it can't distinguish a stranded draft from the ~350ms flash where our OWN
  // just-sent reply sits on the "❯" line waiting for the bridge's pending Enter. The stabilised value
  // (same text must persist ~1.5s) gates the preview's APPEARANCE so that flash never surfaces (the
  // composer adds a second guard: it suppresses a draft matching what it just sent); once shown, the
  // preview's text tracks the RAW line live, so host typing streams in without ever touching the input.
  const terminalDraft = useStableTerminalDraft(rawTerminalDraft);

  // Find-in-output: search the already-fetched buffer. The bar takes over the header while open;
  // AnsiOutput highlights matches and reports the count back here; prev/next scrolls the focused
  // match into view. Opening freezes the tail so matches don't shift under you as polls land.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  useEffect(() => {
    setCurrentMatch(0); // a fresh query starts from the first match
  }, [findQuery]);
  const handleMatchCount = useCallback((n: number) => {
    setMatchCount(n);
    setCurrentMatch((c) => (n === 0 ? 0 : Math.min(c, n - 1)));
  }, []);
  function gotoMatch(delta: number) {
    if (matchCount === 0) return;
    setFollowing(false); // freeze the tail so scroll-into-view doesn't fight the live re-pin
    setCurrentMatch((c) => (c + delta + matchCount) % matchCount);
  }
  function openFind() {
    setFollowing(false); // freeze the buffer so the search target is stable while you type
    setFindOpen(true);
  }
  function closeFind() {
    setFindOpen(false);
    setFindQuery("");
  }
  // Find searches what is on screen: the conversation, or the terminal mirror.
  const findSubject = showConversation ? "chat" : "terminal";
  // The chrome's height, as --chat-chrome-height on the chat: on a phone the thread scrolls under the
  // chrome and starts below it (styles/chat.css). Set straight on the element, so a strip stepping
  // aside for the keyboard re-measures without a render.
  const chatRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const chrome = chromeRef.current;
    const root = chatRef.current;
    if (!chrome || !root) return;
    const measure = () => root.style.setProperty("--chat-chrome-height", `${Math.round(chrome.getBoundingClientRect().height)}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(chrome);
    return () => observer.disconnect();
  }, []);
  // The mirror centres its current hit when it moves to it; this runs after that (a parent's effect
  // follows its children's) and leaves the hit a third down what the reader sees, under the chrome.
  // The conversation places its own (live-conversation).
  useEffect(() => {
    const root = chatRef.current;
    if (!findOpen || showConversation || matchCount === 0 || !root) return;
    const hit = root.querySelector<HTMLElement>('[data-find-match="current"]');
    let scroller = hit?.parentElement ?? null;
    while (scroller && scroller !== root && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    if (!hit || !scroller || scroller === root) return;
    const view = scroller.getBoundingClientRect();
    const chrome = root.querySelector("[data-chat-chrome]")?.getBoundingClientRect();
    const inset = chrome ? Math.max(0, chrome.bottom - view.top) : 0;
    scroller.scrollTop = thirdScrollTop({ scrollTop: scroller.scrollTop, viewTop: view.top, viewBottom: view.bottom, hitTop: hit.getBoundingClientRect().top, inset });
  }, [findOpen, showConversation, findQuery, currentMatch, matchCount]);

  // What the top of the buffer can offer — see the JSX for why these are mutually exclusive.
  // `historyAvailable`: the pane reported an agent session, so a transcript exists to open.
  // `moreScrollback`: Herdr says this pane can still yield lines beyond the window we've asked for,
  // AND we're under the cap Herdr's own read clamp imposes. `readableLines` is undefined on an older
  // bridge/Herdr; treat that as "no idea" and stay hidden rather than offer a tap that fetches nothing.
  const historyAvailable = hasConversation;
  const moreScrollback =
    agent?.readableLines !== undefined &&
    requestedLines < agent.readableLines &&
    canGrowRequestedLines(paneId, session);

  // Load older scrollback: raise the per-pane requested line count and refetch. The enlarged buffer
  // prepends older lines at the top, so we adopt it into the frozen display and re-anchor the scroll
  // position (measure height before, restore after) to keep the content you were reading in place.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  const adoptTarget = useRef<number | null>(null); // the requestedLines a pending grow is waiting on
  const pendingRestore = useRef(false); // re-anchor scroll after the enlarged display paints
  function loadOlder() {
    if (loadingOlder || !canGrowRequestedLines(paneId, session)) return;
    const el = listRef.current?.getScrollElement();
    olderAnchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    setLoadingOlder(true);
    setFollowing(false); // stay put in history rather than snapping to the tail
    adoptTarget.current = growRequestedLines(paneId, session);
    revalidator.revalidate();
  }
  // Adopt the enlarged buffer into the frozen display once the *grown* fetch lands — keyed on the
  // requested line count so a stale in-flight poll (still on the old window) can't adopt early.
  // Adopts the whole {text, revision} pair (props from the same loader result) so the frozen
  // snapshot stays coherent for the race guard.
  useEffect(() => {
    const target = adoptTarget.current;
    if (target === null || requestedLines < target) return;
    adoptTarget.current = null;
    setLoadingOlder(false);
    if (text === display) {
      olderAnchor.current = null; // nothing new arrived (buffer shorter than the window)
      return;
    }
    pendingRestore.current = true;
    setShown({ text, revision });
  }, [requestedLines, text, revision, display]);
  // After the enlarged display paints, keep the previously-visible content anchored (content grew at
  // the top, so push scrollTop down by the height delta).
  useLayoutEffect(() => {
    if (!pendingRestore.current) return;
    pendingRestore.current = false;
    const anchor = olderAnchor.current;
    const el = listRef.current?.getScrollElement();
    if (anchor && el) el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    olderAnchor.current = null;
  }, [display]);

  // Opening / switching into this pane must land on the live tail. Stickiness usually handles it,
  // but the first flex layout + AnsiOutput paint can race; pin once after mount so a tab/pane open
  // never strands you at the oldest scrollback.
  useLayoutEffect(() => {
    listRef.current?.scrollToBottom();
  }, []);

  // After a successful send, snap the mirror back to the live tail so the reply's result is visible.
  const onSent = () => {
    setFollowing(true);
    revalidator.revalidate();
    listRef.current?.scrollToBottom();
  };

  const interactionRevision = showConversation ? modelSource.revision : shown.revision;

  // Tap a prompt-select option. This can type into a real terminal, so it runs the revision-based
  // race guard first (fresh fetch → revision + re-derived-menu equality); only a clean match sends
  // the option's keys. The guard checks against the FROZEN pair's revision — the menu the user
  // tapped was derived from `shown.text`, so `shown.revision` is the revision of what they saw
  // (the live `revision` prop may have advanced under a frozen mirror). A stale tap is discarded
  // with a "menu changed" notice and a revalidate; a clean send snaps back to the tail so the
  // result is visible. The composer stays live for the free-text rows we don't render as buttons.
  const handlePromptAction = useCallback(
    async (action: PromptBlockAction, prompt: PromptModel) => {
      if (readOnly) {
        setStatus(refusedWrite, "error");
        return false;
      }
      const base = {
        paneId,
        session,
        requestedLines,
        detectedRevision: interactionRevision,
        agent: agent?.agent,
        prompt,
      };
      // Two recipes behind one block: a single guarded keystroke for an option, and the plan
      // dialog's multi-step feedback sequence (digit → verify focus → type → Enter, which denies the
      // plan and hands the agent the text — see lib/prompt-action.ts).
      const result =
        action.kind === "option"
          ? await submitPromptOption({ ...base, option: action.option })
          : await submitPromptFeedback({ ...base, text: action.text });
      // The answered dialog leaving the screen is the receipt, so a sent answer raises no toast (T10).
      if (result.status === "sent") {
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus("Menu changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
      }
      // Reported back so the block can keep a refused feedback draft on screen rather than discard
      // what someone just thumb-typed. Option taps ignore it.
      return result.status === "sent";
    },
    [readOnly, refusedWrite, paneId, session, requestedLines, interactionRevision, agent?.agent, revalidator],
  );

  // Tap a wizard control (an option digit, step navigation, or the review step's submit/cancel).
  // Same shape as handlePromptAction — the guard re-derives the wizard from a FRESH read and only
  // a clean match sends the single keystroke (incremental round-trip; grammar/WIZARD_NOTES.md).
  // gate: Claude's adapter is the only one that emits `wizard` (buildBlocks routes through the pane's
  // adapter — see harness/registry.ts), so this handler cannot fire for any other agent. omp has an
  // adapter now and still never lifts this kind; it is Tier 1 and emits raw only.
  const handleWizardAction = useCallback(
    async (keys: string[], wizard: WizardModel) => {
      if (readOnly) {
        setStatus(refusedWrite, "error");
        return;
      }
      const result = await submitWizardKeys({
        paneId,
        session,
        requestedLines,
        detectedRevision: interactionRevision,
        agent: agent?.agent,
        wizard,
        keys,
      });
      if (result.status === "sent") {
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus("Wizard changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
      }
    },
    [readOnly, refusedWrite, paneId, session, requestedLines, interactionRevision, agent?.agent, revalidator],
  );

  // Tap a preview-dialog control (point at an option, choose the pointed one, the note add/edit/remove,
  // or the wizard step nav). Same guard-first shape as the two handlers above, but the choreography
  // behind an intent can be MULTI-step (digit→verify; n→verify→type→Escape — see lib/preview-action.ts
  // and grammar/NOTES_NOTES.md), so the handler dispatches on the intent kind.
  // gate: Claude's adapter is the only one that emits `preview-select` — no other registered adapter
  // lifts this kind, so this handler cannot fire for another agent.
  const handlePreviewAction = useCallback(
    async (action: PreviewBlockAction, preview: PreviewSelectModel) => {
      if (readOnly) {
        setStatus(refusedWrite, "error");
        return;
      }
      const base = {
        paneId,
        session,
        requestedLines,
        detectedRevision: interactionRevision,
        agent: agent?.agent,
        preview,
      };
      const result =
        action.kind === "point"
          ? await submitPreviewPoint({ ...base, option: action.option })
          : action.kind === "choose"
            ? await submitPreviewChoice({ ...base, option: action.option })
            : action.kind === "note"
              ? await submitPreviewNote({ ...base, text: action.text })
              : await submitPreviewKeys({ ...base, keys: action.keys });
      // Pointing only moves the pointer: nothing was answered. The tapped row stays busy until the
      // refreshed card shows its preview, so a second tap can't act on the read it replaced.
      if (result.status === "sent" && action.kind === "point") await revalidator.revalidate();
      else if (result.status === "sent") {
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus("Dialog changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
        revalidator.revalidate();
      }
    },
    [readOnly, refusedWrite, paneId, session, requestedLines, interactionRevision, agent?.agent, revalidator],
  );

  // Tap a multi-select control (toggle a checkbox, Submit, the "Chat about this" escape, or the
  // review screen's confirm/cancel). Same guard-first shape as the wizard handler — the guard
  // re-derives the dialog from a FRESH read; toggle sends one digit, Submit drives the closed-loop
  // Down→Up→verify→Enter macro (see lib/multi-select-action.ts). gate: Claude's adapter is the only
  // one that emits `multi-select`, so this handler cannot fire for another agent.
  const handleMultiSelectAction = useCallback(
    async (action: MultiSelectIntent, multi: MultiSelectModel) => {
      if (readOnly) {
        setStatus(refusedWrite, "error");
        return;
      }
      const result = await submitMultiSelectIntent({
        paneId,
        session,
        requestedLines,
        detectedRevision: interactionRevision,
        agent: agent?.agent,
        multi,
        intent: action,
      });
      if (result.status === "sent") {
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus("Selection changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
      }
    },
    [readOnly, refusedWrite, paneId, session, requestedLines, interactionRevision, agent?.agent, revalidator],
  );

  // Tap a generic-menu control (a footer-named key like Enter/s/Esc, or an arrow). Same guard-first
  // shape as the handlers above; the arrow taps pass `nav`, which swaps the guard's signature check
  // for an identity-only one (moving the highlight is the tap's own effect — see lib/menu-action.ts).
  // gate: Claude's adapter is the only one that emits `menu` — omp's modals deliberately stay raw
  // (harness/omp/index.ts), so this handler cannot fire for another agent.
  const handleMenuAction = useCallback(
    async (action: MenuBlockAction, menu: MenuModel) => {
      if (readOnly) {
        setStatus(refusedWrite, "error");
        return;
      }
      const result = await submitMenuKeys({
        paneId,
        session,
        requestedLines,
        detectedRevision: interactionRevision,
        agent: agent?.agent,
        menu,
        keys: action.keys,
        nav: action.nav,
        canWrite: () => writableRef.current && modelSource.isCurrent(),
      });
      if (result.status === "sent") {
        if (liveModelBlock?.menu.signature === menu.signature && modelPresent) {
          const observed = await waitForModelAction({ paneId, session, agent: agent?.agent,
            requestedLines, previous: menu });
          if (!modelSource.isCurrent()) return;
          if (!observed.ok) {
            setStatus(observed.error, "warn");
            revalidator.revalidate();
            return;
          }
          modelSource.observe(observed.pane);
          if (observed.kind === "closed") {
            localModel.released();
            panels.modelCompleted();
            const confirmed = menu.actions.some((entry) => !entry.cancel && entry.keys.join() === action.keys.join());
            setStatus(confirmed ? "Model settings applied" : "Model settings closed", confirmed ? "success" : "info");
          } else setStatus(observed.menu.kind === "reasoning" ? "Choose reasoning, then apply the change" : "Selection updated — apply to save", "info");
          revalidator.revalidate();
          return;
        }
        localModel.released();
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus("The screen changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
      }
    },
    [readOnly, refusedWrite, paneId, session, requestedLines, interactionRevision, agent?.agent, revalidator, localModel.released,
      liveModelBlock, modelPresent, modelSource.observe, modelSource.isCurrent, panels.modelCompleted],
  );

  // A dialog the card does not answer (a generic menu, a preview with its side panel and notes, or one
  // the bridge has not read yet) is drawn by its own grammar's block, in the same place as the card:
  // the conversation's newest line, inside its scroller, never floating over the transcript. It waits
  // for the bridge's first answer (or failure), so a dialog the card will cover never flashes first.
  const bridgeHeard = interactions.loaded || interactions.stale;
  const dialogInline = !subagent && showConversation && bridgeHeard && dialogPresent && !modelPresent && !unknownInteraction && !showCard && !receipt;
  const inlineDialog = dialogInline ? (
    <AnsiOutput text={modelSource.text} nativeOnly agent={agent?.agent}
      onPromptAction={handlePromptAction} onWizardAction={handleWizardAction}
      onPreviewAction={handlePreviewAction} onMultiSelectAction={handleMultiSelectAction}
      onMenuAction={handleMenuAction} promptDisabled={readOnly || gone || connecting} />
  ) : null;
  // The footer only holds the block's slot, so a poll that redraws the block leaves it (and the
  // memoised transcript around it) alone; the block itself arrives through InlineDialog.
  const conversationFooterWithDialog = useMemo(() => !dialogInline ? threadFooter : <>
    {threadFooter}
    <div data-follow-stop className="chat-follow-stop mt-5"><InlineDialogSlot /></div>
  </>, [dialogInline, threadFooter]);
  const dialogInThread = (showCard && cardCovers) || dialogInline;

  // NOTE: the composer is deliberately NOT auto-focused on open/switch — that would pop the Android
  // keyboard and cover the output. You read the pane first, then tap the input to type. (Explicit
  // actions inside the composer still focus it; the mirror tap focuses it via composerRef.)

  // Switch to another pane from the strips (DetailRoute keys AgentChat by pane, so this remounts
  // fresh — composer resets — same as opening from home).
  function switchTo(id: string) {
    if (id !== paneId) onSelect(id);
  }

  // Jump to another tab in this space by opening one of its panes (the in-pane tab bar).
  function goToTab(tabId: string) {
    if (!agent || tabId === agent.tabId) return;
    const target = paneInTab(tabId, agents, shellPanes);
    if (target) switchTo(target.paneId);
  }

  // A project pane's title opens the project's page. A workspace has no page of its own: its tabs
  // and panes are the strips above the conversation.
  function openProject(slug: string) {
    navigate(projectPath(slug, session));
  }

  // Tapping the terminal mirror focuses the composer so you can start typing right away. Three bails:
  //  - the operator turned "Tap to type" off (View). It is on by default and always has been — the
  //    mirror as one big "start typing" target is the fastest path from reading to replying on a
  //    phone. But the same handler makes the mirror unable to behave like a document, which is what
  //    someone expects who is trying to interact with a LINE rather than reply to it, and they read
  //    it as the tap being absorbed. Off, the mirror keeps its buttons and its links; it just stops
  //    volunteering the keyboard. (What it still cannot offer is a tappable agent-printed hyperlink:
  //    herdr's `pane.read` strips OSC 8, so the link target never reaches Nenu at all.)
  //  - the tap landed on an interactive control INSIDE the mirror — a native prompt/wizard/preview
  //    button, the Load-older button, or the note editor's own textarea. Their click bubbles up to
  //    this handler, and focusing the composer here would pop the soft keyboard on every option tap
  //    (and steal focus from the note editor). Only a tap on the raw terminal text should focus.
  //  - the user is selecting text (a long-press selection), so copy works instead of the tap
  //    collapsing the selection and popping the keyboard.
  function focusFromMirror(e: ReactMouseEvent<HTMLDivElement>) {
    if (!prefs.tapToFocus) return;
    const target = e.target as Element | null;
    // The `a` is what keeps a tap on an autolinked URL (components/ansi-output) from popping the
    // keyboard on top of the page it just opened. Don't trim it out of this selector.
    if (target?.closest?.("button, a, input, textarea, select, [role='textbox']")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    composerRef.current?.focusInput();
  }

  // When the running turn started, for the composer's "Working for …" row: the turn's own start when
  // the journal records one, else the user message that opened it.
  const workingSince = useMemo(() => {
    const entries = conversation.history?.available ? conversation.history.entries : [];
    const last = entries.at(-1);
    if (last?.turn?.status === "running" && last.turn.startedAt) return last.turn.startedAt;
    return entries.findLast((entry) => entry.role === "user")?.ts;
  }, [conversation.history]);

  const nativeUsage = agent?.agent === "claude" ? nativeTelemetry?.telemetry : undefined;
  const telemetry = nativeUsage ?? (conversation.history?.available ? conversation.history.telemetry : undefined);
  const telemetryProps = {
    telemetry,
    stale: conversation.error || connecting,
    modelAvailable,
    disabled: readOnly || gone || connecting || dialogPresent || waitNotice !== null,
    panel: panels.panel,
    onPanelChange: (next: Parameters<typeof panels.changePanel>[0]) => { void panels.changePanel(next); },
    modelOpen: panels.panel === "model",
    modelTriggerRef,
    onChooseModel: panels.toggleModel,
    onCompact: () => { void composerRef.current?.compactContext(); },
  };

  const harnessWithSubagents = agent?.agent === "codex" || agent?.agent === "claude";
  const toggleRawTerminal = () => { setSubagent(null); setRawTerminal(!prefs.rawTerminal); };
  // The ⋯ menu holds only the pane's views. Message tools live under the composer's chevron, the
  // context and usage in the composer row, and background work behind the processes chip.
  const viewActions: ConversationAction[] = [
    ...(display ? [{ id: "find", label: `Find in ${findSubject}`, icon: Search, run: openFind }] : []),
    ...(hasConversation ? [{ id: "history", label: "Conversation history", icon: ScrollText,
      run: () => showConversation ? setHistoryRequest((key) => key + 1) : navigate(historyPath(paneId, session)) }] : []),
    ...(conversationCapable ? [{ id: "files", label: "Artifacts and files", icon: Paperclip, run: () => setFilesOpen(true) }] : []),
    ...(!desktop && conversationCapable ? [{ id: "terminal", label: "Terminal view", icon: TerminalSquare, on: prefs.rawTerminal, run: toggleRawTerminal }] : []),
    ...composerControls.filter((control) => control.group === "View"),
  ];
  // Renaming and closing the pane and its tab, which otherwise hide behind a long-press on a chip.
  // Each opens the strip's own sheet, so the rename field and the close confirmation are the same.
  const [paneSheet, setPaneSheet] = useState<"pane" | "tab" | null>(null);
  const tab = agent && tabs.find((t) => t.tabId === agent.tabId);
  const tabTitle = tab ? tabName(tab.label, tabs.filter((t) => t.workspaceId === tab.workspaceId).indexOf(tab) + 1) : "";
  const paneActions: ConversationAction[] = agent && !readOnly ? [
    { id: "pane", label: "Rename or close pane…", icon: AppWindow, run: () => setPaneSheet("pane") },
    ...(tab ? [{ id: "tab", label: "Rename or close tab…", icon: PanelTop, run: () => setPaneSheet("tab") }] : []),
  ] : [];

  // Background work: workflows and commands (Claude's activity reader) and subagents, as one list
  // behind the chip in the composer row.
  const activity = useActivity(paneId, session, agent?.agent === "claude" && conversationCapable && !gone && !connecting);
  const subagents = useSubagents({ paneId, session, enabled: harnessWithSubagents && !gone && !connecting, open: processesOpen,
    selected: subagent, onLost: () => setSubagent(null) });
  // The selected subagent as the list last read it, so the header's state stays current.
  const subagentView = subagent && ((subagents.list?.available ? subagents.list.agents.find((a) => a.id === subagent.agent.id) : undefined) ?? subagent.agent);
  const subagentHarness = agent?.agent === "codex" ? "codex" : "claude";
  const processes = useMemo(() => buildProcesses(activity.data, subagents.list, { activityStale: activity.stale, subagentsStale: subagents.stale }),
    [activity.data, subagents.list, activity.stale, subagents.stale]);
  const processesNow = useActivityClock(activity.data, processesOpen || processDetail !== null);
  const openProcessDetail = (next: ProcessDetail) => {
    setProcessDetail(next);
    if (desktop) setProcessesOpen(false);
  };
  const processDetailContent = processDetail &&
    <ProcessDetailView paneId={paneId} session={session} activity={activity} detail={processDetail} now={processesNow} onChange={setProcessDetail} />;
  const published = activity.data?.available ? activity.data.artifacts : [];
  const processesControl = !isShell && !subagent && <ProcessesChip processes={processes} published={published.length} desktop={desktop} open={processesOpen}
    onOpenChange={(open) => { setProcessesOpen(open); if (!open && !desktop) setProcessDetail(null); }}
    list={<ProcessesList processes={processes} artifacts={published} now={processesNow} stale={activity.stale || subagents.stale}
      onRetry={() => { activity.refresh(); subagents.refresh(); }} onDetail={openProcessDetail}
      onOpenSubagent={(item) => {
        if (!subagents.list?.available) return;
        setProcessesOpen(false);
        setProcessDetail(null);
        selectSubagent({ agent: item.agent, parentKey: subagents.list.sessionKey });
      }} />}
    detail={processDetail} detailContent={processDetailContent} detailName={processDetail ? detailTitle(processDetail, activity) : undefined}
    onBack={() => setProcessDetail(null)} />;
  // The pane's one name, as its row in the sidebar and Home say it, and where it lives under it.
  const title = titleOverride ?? (agent ? displayName(agent, projects) : "");
  const place = agent && displayPlace(agent, projects);

  const findBar = findOpen ? (
    <FindBar query={findQuery} onQueryChange={setFindQuery} count={matchCount} current={currentMatch} subject={findSubject}
      onPrev={() => gotoMatch(-1)} onNext={() => gotoMatch(1)} onClose={closeFind} />
  ) : undefined;
  const sessionTools = agent && conversationCapable
    ? <ChatFilesBrowser paneId={paneId} session={session} history={conversation.history} open={filesOpen && !subagent} onOpenChange={setFilesOpen} />
    : undefined;
  const actionsMenu = agent && !subagent ? <ConversationActions
    groups={[{ label: "View", actions: viewActions }, { label: "Tab and pane", actions: paneActions }]}
    recovery={hasConversation && agent.agent === "codex" ? <ConnectConversation key={displayScope} paneId={paneId} session={session} disabled={readOnly || connecting || gone} onConnected={conversation.refresh} /> : undefined}
    folder={agent.cwd ? shortCwd(agent.cwd) : undefined}
  /> : undefined;

  // On a phone the title opens the navigation the brand mark used to, where every workspace, tab and
  // pane is a tap away; a desk keeps that in the sidebar. A project's title opens its page instead.
  const navigation = useContext(WorkbenchNavigationContext);
  const opensNavigation = !desktop && navigation !== undefined;
  const titleLabel = agent && <span className="flex min-w-0 flex-1 flex-col">
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate text-headline font-semibold lg:text-subhead lg:tracking-normal">{title}</span>
      {!project && opensNavigation && <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      {!isShell && <span className="sr-only">, {STATUS_LABEL[agent.status]}</span>}
    </span>
    {/* The place, never the folder: the folder sits in the ⋯ menu and in this line's tooltip. The
        place gives up width first, so the tab that tells two chats apart survives. An outage is the
        banner's, the card's or the box's to name, never this line's: the screen names it once. */}
    <span data-chat-subtitle title={agent.cwd || undefined} className="flex min-w-0 items-center gap-1.5 text-footnote text-muted-foreground">
      {isShell
        ? <TerminalSquare aria-hidden="true" className="size-3.5 shrink-0" />
        : <StatusDot status={agent.status} className={cn("size-2", connecting && "opacity-40")} />}
      <span className="min-w-0 truncate">{place?.place}</span>
      {place?.tab && <><span aria-hidden="true" className="shrink-0">›</span><span className="max-w-[60%] shrink-0 truncate">{place.tab}</span></>}
    </span>
  </span>;

  return (
    <div
      ref={chatRef}
      className="workbench-chat relative flex min-h-0 w-full min-w-0 max-w-[100dvw] flex-1 flex-col overflow-x-hidden"
      data-keyboard-open={keyboardOpen || undefined}
      data-view={showConversation ? "chat" : "terminal"}
    >
      {/* The chrome: the header, the read-only note, the strips and a spawn's status, one stack. On a
          phone it is a translucent bar the thread scrolls under (styles/chat.css). */}
      <div ref={chromeRef} data-chat-chrome className="chat-chrome">
        {/* Header — the SAME AppHeader shell the dashboard and space mount, so the Nenu mark is
            identical on every screen (no hand-rolled bar to drift). The pane's own bits ride in via
            slots: the title as the center, the pane's tools as the right cluster, and the find bar as
            the full-row takeover while searching. */}
        {docked ? docked.header({ terminal: !showConversation, canToggle: conversationCapable, setTerminal: (terminal) => { setSubagent(null); setRawTerminal(terminal); },
          find: findBar, menu: agent ? <>{sessionTools}{actionsMenu}</> : undefined }) : <AppHeader
          bridge={bridge}
          error={error}
          back={subagent ? { label: "Main", onClick: () => setSubagent(null), inPlace: true } : threadBack(projects, paneId, agents, session) ?? { label: "Home", onClick: onBack }}
          override={subagent ? undefined : findBar}
          rightLead={
            subagent ? undefined : agent ? (
              <>
                {headerAction}
                {sessionTools}
                {desktop && conversationCapable && (
                  <button
                    type="button"
                    onClick={toggleRawTerminal}
                    aria-label={prefs.rawTerminal ? "Show conversation" : "Show raw terminal"}
                    aria-pressed={prefs.rawTerminal}
                    title={prefs.rawTerminal ? "Show conversation" : "Show raw terminal"}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground active:bg-muted"
                  >
                    {prefs.rawTerminal ? <MessageSquareText aria-hidden="true" className="size-4" /> : <TerminalSquare aria-hidden="true" className="size-4" />}
                  </button>
                )}
                {actionsMenu}
              </>
            ) : headerAction
          }
        >
          {/* The screen's heading: the pane's name over its place. A project's title opens the
              project's page; any other opens the navigation on a phone. A subagent's view names the
              subagent and what it is. */}
          {subagentView ? <h1 className="flex min-w-0 flex-1 flex-col px-1">
            <span className="truncate text-headline font-semibold lg:text-subhead lg:tracking-normal">{subagentView.name}</span>
            <span className="truncate text-footnote text-muted-foreground"><SubagentSubtitle agent={subagentView} harness={subagentHarness} /></span>
          </h1> : agent ? <h1 className="flex min-w-0 flex-1">{project ? (
            <button
              type="button"
              onClick={() => openProject(project.slug)}
              aria-label={`Open ${project.name} overview`}
              className={cn(TITLE_SHAPE, "transition-colors active:bg-muted/60")}
            >
              {titleLabel}
            </button>
          ) : opensNavigation ? (
            <button
              type="button"
              data-chat-title
              aria-haspopup="dialog"
              aria-expanded={navigation.open}
              onClick={navigation.onOpen}
              className={cn(TITLE_SHAPE, "transition-colors active:bg-muted/60")}
            >
              {titleLabel}
            </button>
          ) : <span className={TITLE_SHAPE}>{titleLabel}</span>}</h1> : (
            <h1 className="min-w-0 flex-1 truncate px-1 text-headline font-semibold lg:text-subhead lg:tracking-normal">{closed ? "Pane closed" : connecting ? "Pane" : "Pane not found"}</h1>
          )}
        </AppHeader>}
        {/* A project's overlay (its Threads and PRs) brings its own tabs, so only the header stays above
            it: the rest of the chrome belongs to the chat underneath. */}
        {!overlay && <>
        {/* Read-only notice when this device isn't allowlisted (the composer below is disabled too). */}
        <ReadOnlyBanner device={device} />

        {/* A subagent's view steps the strips aside: its header leads back to Main, not to a tab. */}
        {!subagent && (strip !== undefined ? strip : <>
        {/* In-pane tab bar: the current space's tabs above the mirror — switch tab without leaving the
            pane, or create one with +. */}
        {agent && (
          <TabStrip
            workspaceId={agent.workspaceId}
            tabs={tabs}
            agents={agents}
            selected={agent.tabId}
            onSelect={goToTab}
            onNewTab={(workspaceId) => openNewAgent({ kind: "tab", workspaceId })}
            session={session}
            readOnly={readOnly}
            onRenamed={() => revalidator.revalidate()}
            // Closing the tab this pane lives in kills the pane too; the refreshed snapshot without it
            // is what moves you to the tab beside it (DetailRoute), the same as a close made in Herdr.
            onClosed={() => revalidator.revalidate()}
            onMoved={() => revalidator.revalidate()}
          />
        )}
        </>)}

        {/* Pane switcher: the panes that share this tab (space › tab › pane). Mobile shows them as a
            tabbed row rather than tiling the panes; only appears when the tab holds more than one. */}
        {agent && !subagent && (
          <PaneStrip
            panes={[...agents, ...shellPanes]
              .filter((p) => p.workspaceId === agent.workspaceId && p.tabId === agent.tabId)
              .sort((a, b) => a.paneId.localeCompare(b.paneId))}
            currentPaneId={paneId}
            projects={projects}
            onSelect={switchTo}
            session={session}
            readOnly={readOnly}
            onRenamed={() => revalidator.revalidate()}
            // As with a tab: closing the open pane lands on another one in its tab (DetailRoute).
            onClosed={() => revalidator.revalidate()}
          />
        )}

        <SpawnStatus paneId={paneId} />
        {isShell && !spawning && <StartAgent paneId={paneId} session={session} disabled={readOnly || connecting || gone} ready={Boolean(text.trim())} />}
        </>}
      </div>
      {overlay && <div className="chat-below-chrome flex min-h-0 min-w-0 flex-1 flex-col">{overlay}</div>}

      {/* The pane's folder, for every work log under it: the conversation's and a subagent's. */}
      <PaneCwdContext value={agent?.cwd ?? ""}>
      <div className="flex min-h-0 min-w-0 flex-1" hidden={Boolean(overlay)}>
      {/* Content region below the header — the mirror inside is the scroller. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Terminal mirror — tapping it focuses the composer so you can start typing right away
            (unless you're selecting text to copy, which the tap must not collapse). */}
        {/* min-w-0 only — do NOT set overflow-x-hidden here: that forces overflow-y to `auto` (CSS
            quirk) and makes this wrapper a second vertical scroller competing with ChatMessageList. */}
        {/* border-t: on a desk the chrome's bands draw no edge of their own, so the view under them
            draws it. On a phone the chrome draws its own hairline and these slide under it. */}
        {gone ? (
          <div className="chat-below-chrome flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto border-t border-border/40">
            <PaneGone closed={closed !== undefined} unsure={connecting}
              next={next && { paneId: next.paneId, name: displayName(next, projects) }}
              onOpen={switchTo} onHome={onBack} />
          </div>
        ) : subagent ? <SubagentConversation key={`${displayScope}:${subagent.parentKey}:${subagent.agent.id}`} paneId={paneId} session={session} selection={subagent}
          harness={subagentHarness} ownHeader={Boolean(docked)} onMain={() => setSubagent(null)}
          onWrite={readOnly || gone || connecting ? undefined : (draft) => { setForward(draft); setSubagent(null); }} /> : showConversation ? (
          <div className="chat-thread min-h-0 min-w-0 flex-1 border-t border-border/40">
            <InlineDialog.Provider value={inlineDialog}><QuestionLiveContext.Provider value={dialogInThread ? "card" : interaction === undefined ? null : "dialog"}><QuestionReplyContext.Provider value={readOnly || gone || connecting ? null : (text) => composerRef.current?.prepareAnswer(text)}><LiveConversation paneId={paneId} session={session} activityStatus={connecting ? undefined : agentBusy(agent, modelSource.text) ? "working" : agent?.status}
              history={conversation.history} loading={conversation.loading} error={conversation.error && !error}
              recovery={agent?.agent === "codex" ? <ConnectConversation key={displayScope} paneId={paneId} session={session} disabled={readOnly || connecting || gone} onConnected={conversation.refresh} /> : undefined}
              onRetry={conversation.refresh} followKey={followKey} historyRequest={historyRequest} searching={findOpen}
              query={findOpen ? findQuery : ""} currentMatch={currentMatch}
              onMatchCount={findOpen ? handleMatchCount : undefined}
              footer={conversationFooterWithDialog} waiting={dialogInThread} /></QuestionReplyContext.Provider></QuestionLiveContext.Provider></InlineDialog.Provider>
          </div>
        ) : <div className="min-h-0 min-w-0 flex-1 border-t border-border/40" onClick={focusFromMirror}>
          <ChatMessageList
            ref={listRef}
            dep={display}
            onAtBottomChange={setFollowing}
            hasNew={hasNew}
            className="chat-scroll-under px-2 py-3 lg:px-(--page-gutter)"
          >
            {display ? (
              <>
                {/* Top-of-buffer affordance, reached by scrolling up. WHICH button appears is decided
                    by what the pane can actually offer, because the two are never both possible:

                      • an agent pane with a transcript → "Show entire history". Its terminal runs on
                        the alternate screen, which keeps no scrollback ring, so the mirror can never
                        show more than the viewport — the agent's own session log is the only history
                        that exists (see bridge/transcript.ts).
                      • a pane with real scrollback (a shell, on the primary screen) → "Load older",
                        which grows the requested window.
                      • neither → nothing.

                    This used to be gated on `truncated`, which Herdr never sets true — so the button
                    rendered on no pane at all. `readableLines` (scrollback depth + viewport) is the
                    signal that actually works. */}
                {historyAvailable ? (
                  <button
                    type="button"
                    onClick={() => navigate(historyPath(paneId, session))}
                    className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-footnote font-medium text-muted-foreground transition-colors active:bg-muted/50 coarse:min-h-11"
                  >
                    <ScrollText className="size-3.5" />
                    Show entire history
                  </button>
                ) : moreScrollback || loadingOlder ? (
                  // Kept while it loads: the step that reaches Herdr's cap leaves no more to offer, and
                  // the button vanished mid-load instead of saying it was busy.
                  <button
                    type="button"
                    onClick={loadOlder}
                    disabled={loadingOlder}
                    aria-busy={loadingOlder || undefined}
                    className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-footnote font-medium text-muted-foreground transition-colors active:bg-muted/50 coarse:min-h-11"
                  >
                    {loadingOlder ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ArrowUpToLine className="size-3.5" />
                    )}
                    {loadingOlder ? "Loading…" : "Load older"}
                  </button>
                ) : null}
                <AnsiOutput
                  text={display}
                  wrap={prefs.wrap}
                  fontSize={prefs.fontSize}
                  query={findOpen ? findQuery : ""}
                  currentMatch={findOpen ? currentMatch : -1}
                  onMatchCount={findOpen ? handleMatchCount : undefined}
                  agent={grammarsOn ? agent?.agent : undefined}
                  onPromptAction={handlePromptAction}
                  onWizardAction={handleWizardAction}
                  onPreviewAction={handlePreviewAction}
                  onMultiSelectAction={handleMultiSelectAction}
                  onMenuAction={handleMenuAction}
                  promptDisabled={readOnly || gone}
                />
              </>
            ) : pending ? (
              <div role="status" aria-label="Reading the terminal" className="flex items-center justify-center gap-2 py-16 text-footnote text-muted-foreground">
                <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />Reading the terminal…
              </div>
            ) : (
              <div className="py-16 text-center text-subhead text-muted-foreground">(no recent output)</div>
            )}
          </ChatMessageList>
        </div>}

        {/* Composer and its controls stay mounted while the workbench's inspectors open and close. A gone
            pane has nothing to write to, so it has none. */}
        {!gone && <div className="workbench-composer relative" hidden={Boolean(subagent)} inert={Boolean(subagent)}>
          {!subagent && showConversation && <WorkbenchModelPanel scope={JSON.stringify([paneId, session])}
            open={panels.panel === "model"} anchorRef={modelTriggerRef} agent={agent?.agent}
            text={modelSource.text} menu={liveModelBlock} modelPresent={modelPresent} catalog={catalog}
            reportedModel={telemetry?.model}
            disabled={readOnly || gone || connecting} closing={panels.closing}
            onDismiss={() => { void panels.changePanel(null); }} onLoad={localModel.load} onMenuAction={handleMenuAction}
            onApply={localModel.apply} onApplyError={() => revalidator.revalidate()} />}
          {!showConversation && conversationFooter && <div className="max-h-[40dvh] overflow-y-auto px-3 pb-1">{conversationFooter}</div>}
          {!subagent && showConversation && wait?.kind === "interaction" && (
            <TerminalWaitRow key={wait.hint} hint={wait.hint} agent={agent?.agent} onShow={() => setRawTerminal(true)}
              onKeys={() => { setRawTerminal(true); composerRef.current?.openDock("keys"); }} />
          )}
          {!subagent && showConversation && waitNotice !== null && (
            <p data-terminal-notice className="flex min-w-0 items-center gap-2 px-4 pb-1 text-footnote text-muted-foreground">
              <Hourglass aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{waitNotice}</span>
            </p>
          )}

          {/* The agent's statusline, re-surfaced as app chrome (its branch/model/ctx/permission mode
              would otherwise vanish with the stripped input box). Sits directly above the composer,
              as it did in the TUI. Verbatim text — React text nodes, so no XSS surface.

              STACKED, one row per line, each truncated — deliberately, over the two alternatives:
              joining the rows with a separator would put ~150 chars on a strip that fits ~50 at the
              mirror's default size on a phone, truncating away exactly the fields (branch, permission mode) this
              exists to surface; wrapping makes the strip's height depend on the pane width and turns
              a column-aligned statusline into ragged prose. Stacking also preserves the shape the
              user themselves configured in the TUI, so it reads as the same thing they know.
              Height is bounded upstream (MAX_STATUS_LINES caps the run stripChrome will claim), so
              there is no second cap here; the mirror is a flex child that shrinks, never pushed off. */}
          {!showConversation && statusLines.length > 0 && (
            <div
              className={cn(
                "border-t border-border/40 px-3 py-1 font-mono leading-tight",
                // The strip carries the agent's OWN terminal colour, so it renders in the mirror's
                // dark space and inverts in light with it (ADR 0002) — a bright statusline colour is
                // chosen against a near-black background and is illegible re-themed onto app chrome.
                // It also makes the strip read as the bottom of the pane it was cut from, which is
                // where the TUI drew it.
                MIRROR_SPACE,
                MIRROR_INVERT,
              )}
              // The mirror's own size, which the operator sets: these are the pane's last rows, so
              // they keep the terminal grid's exemption from the 13px floor. Floored, they would sit
              // larger than the rows above them and cut the statusline sooner than the mirror cuts
              // its own lines.
              style={{ fontSize: `${prefs.fontSize}px` }}
            >
              {statusLines.map((row, i) => (
                // Index key: these rows are a positional snapshot of the pane tail, re-derived on
                // every poll — there is no identity to preserve across renders.
                <div key={i} className="truncate">
                  {row.segments.map((s, si) => (
                    // Text nodes only — colour and weight come from the ANSI parse, never markup.
                    // Same XSS boundary as the mirror.
                    <span key={si} style={styleFor(s)}>
                      {s.text}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Background agents, under the statusline as the TUI drew them: stripChrome peels the block
              off the mirror, so this is its one surface. One row until tapped (agents-footer.tsx). */}
          {!showConversation && agentsFooter.length > 0 && <AgentsFooter rows={agentsFooter} />}

          {!subagent && composerTop}
          {!subagent && turnNote(agent) && (
            <p role="status" className="px-3 pt-1 text-footnote text-muted-foreground">{turnNote(agent)}</p>
          )}
          <Composer
            ref={composerRef}
            paneId={paneId}
            session={session}
            agent={agent?.agent}
            isShell={isShell}
            placeholder={project && COMPOSER_PLACEHOLDER[project.role]}
            working={turnRunning(agent, modelSource.text)}
            gone={gone}
            readOnly={readOnly || Boolean(subagent)}
            disconnected={unavailable}
            lockReason={lock}
            lockOnCard={showCard && cardCovers}
            herdrDown={bridge === "disconnected" && !error}
            modelControl={!isShell && <WorkbenchTelemetry {...telemetryProps} mode="model" />}
            processesControl={processesControl}
            onEscape={desktop && processDetail ? () => setProcessDetail(null) : undefined}
            workingSince={workingSince}
            usageControls={!isShell && <WorkbenchTelemetry {...telemetryProps} mode="metrics" />}
            nativeWorkbench={showConversation}
            prepareSend={showConversation ? panels.prepareSend : undefined}
            onInputFocus={() => { void panels.changePanel(null); }}
            dialogPresent={dialogPresent}
            text={text}
            terminalDraft={terminalDraft}
            rawTerminalDraft={rawTerminalDraft}
            prefs={prefs}
            setWrap={setWrap}
            stepFontSize={stepFontSize}
            setRawTerminal={setRawTerminal}
            setTapToFocus={setTapToFocus}
            onSent={() => { onSent(); setFollowKey((key) => key + 1); conversation.refresh(); }}
            onControlsChange={setComposerControls}
          />
        </div>}
      </div>
      {desktop && processDetail && <ProcessPanel title={detailTitle(processDetail, activity)} onClose={() => setProcessDetail(null)}>{processDetailContent}</ProcessPanel>}
      </div>
      </PaneCwdContext>

      {/* Closing the open pane or its tab moves the route to the pane beside it (DetailRoute). */}
      {agent && <PaneActionsSheet open={paneSheet === "pane"} onClose={() => setPaneSheet(null)} pane={agent} name={title}
        session={session} readOnly={readOnly} onRenamed={() => revalidator.revalidate()} onClosed={() => revalidator.revalidate()} />}
      {tab && <TabActionsSheet open={paneSheet === "tab"} onClose={() => setPaneSheet(null)} tab={tab} name={tabTitle}
        session={session} readOnly={readOnly} onRenamed={() => revalidator.revalidate()} onClosed={() => revalidator.revalidate()} />}

    </div>
  );
}

/** The dialog block drawn in the card's place, handed to the conversation's footer slot. */
const InlineDialog = createContext<ReactNode>(null);
function InlineDialogSlot() {
  return <>{useContext(InlineDialog)}</>;
}

/**
 * A screen that waits on a key no grammar could name: one row above the composer, in flow so it
 * never covers the chat. It says what is going on in words, keeps the screen's own hint, and leads to
 * the terminal and its keys. Collapsing leaves a chip naming the waiting screen; the composer is not
 * paused (a message waits for the answer). It offers no key of its own: a declared cancel key is
 * ADR 0053 rule 2, still Proposed. Only the sentence is a live region, never the buttons around it.
 */
function TerminalWaitRow({ hint, agent, onShow, onKeys }: { hint: string; agent?: string; onShow: () => void; onKeys: () => void }) {
  const [collapsed, setCollapsed] = useState(false);
  // It needs the operator, so its dot is the blocked one the pane carries in the header.
  const dot = <span aria-hidden className="size-2 shrink-0 rounded-full bg-status-blocked" />;
  return (
    <section aria-label="Terminal waiting" className="mb-2">
      {collapsed ? (
        <button type="button" aria-expanded={false} onClick={() => setCollapsed(false)}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-card px-3.5 text-footnote font-medium text-foreground transition-colors active:bg-muted">
          {dot}
          Terminal waiting on a key
          <ChevronUp aria-hidden className="size-4 text-muted-foreground" />
        </button>
      ) : (
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
          <div className="flex items-start gap-3">
            <span className="mt-1.5 flex">{dot}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p role="status" className="text-subhead font-medium text-foreground">{agentName(agent)} is showing a screen Nenu can't answer</p>
              <p className="truncate font-mono text-code text-muted-foreground">{hint}</p>
            </div>
            <button type="button" aria-label="Collapse" aria-expanded onClick={() => setCollapsed(true)}
              className="-mt-3 -mr-3 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-muted">
              <ChevronDown aria-hidden className="size-4" />
            </button>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onShow} className={cn(PRIMARY_ACTION, "w-auto flex-1")}>
              <TerminalSquare aria-hidden className="size-4" />Show terminal
            </button>
            <button type="button" onClick={onKeys} className={cn(NEUTRAL_ACTION, "w-auto")}>
              <Keyboard aria-hidden className="size-4" />Keys
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
