import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

// A stand-in for the herdr-organizations CLI, for the e2e bench only. The bridge spawns it through a
// shell stub (bridge.ts); it keeps its projects in the JSON file $NENU_E2E_ORG, prints the `--json`
// documents the bridge reads (Organizations docs/json.md), and appends every argv to
// $NENU_E2E_ORG.calls so a run can report exactly what Nenu asked for. It reaches no Herdr.

interface FakeThread { id: string; title: string; parent_id: string; role: "worker" | "coordinator"; status: string; [key: string]: unknown }
/**
 * A project may carry what the newer documents print: `tasks` (task list), `detail` (project show's
 * extra fields), `routines` (routine list) and `projectStatus` (project status, without its
 * `schema_version`). Without them the fake answers those commands the way an Organizations that
 * predates them does: an unrecognized subcommand.
 */
interface FakeProject {
  slug: string; threads: FakeThread[]; tasks?: unknown[]; detail?: Record<string, unknown>; routines?: unknown[]; projectStatus?: Record<string, unknown>;
  [key: string]: unknown;
}
/**
 * `savedProfiles` are the operator's own, beside the built-ins `profiles` names; `choices: false` is an
 * Organizations without `profile list --json`. A project may name its `coordinator_profile`, the `last`
 * launch, an `open_error` that `open` fails with, and the `open_pane` binding `open` records as
 * `.state/coordinator.json` under $HERDR_PROJECTS_ROOT, as the real one does.
 */
interface FakeState {
  profiles: string[];
  /** `false` is an Organizations without `node move`. */
  moves?: boolean;
  /** `false` is an Organizations without `asks answer`. */
  answers?: boolean;
  /** `asks --json`'s rows; without them the fake answers `asks` as an Organizations that predates it. */
  asks?: Array<{ project: string; [key: string]: unknown }>;
  /** `asks --json`'s decision rows, from the Organizations that answers them; left out without any. */
  decisions?: Array<{ project: string; [key: string]: unknown }>;
  savedProfiles?: Array<{ name: string; harness: string; model: string; reasoning_effort: string; description: string }>;
  choices?: boolean;
  projects: FakeProject[];
}
/** Each harness's effort levels, as Organizations lists them. */
const EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
};

const file = process.env.NENU_E2E_ORG;
if (!file) {
  console.error("fake-org: NENU_E2E_ORG is not set");
  process.exit(2);
}
const argv = process.argv.slice(2);
appendFileSync(`${file}.calls`, JSON.stringify(argv) + "\n");
const state = JSON.parse(readFileSync(file, "utf8")) as FakeState;

/** `--key=value` or `--key value`; positionals are what is left. */
function parse(args: string[]): { flags: Record<string, string>; positionals: string[] } {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") && arg.includes("=")) flags[arg.slice(2, arg.indexOf("="))] = arg.slice(arg.indexOf("=") + 1);
    else if (arg.startsWith("--")) flags[arg.slice(2)] = args[i + 1] !== undefined && !args[i + 1]!.startsWith("--") ? args[++i]! : "";
    else positionals.push(arg);
  }
  return { flags, positionals };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

function start(slug: string, flags: Record<string, string>, role: "worker" | "coordinator", parent: string): void {
  const project = state.projects.find((candidate) => candidate.slug === slug) ?? fail(`no project ${slug}`);
  const task = readFileSync(0, "utf8");
  if (!flags.title || !task.trim()) fail("a title and a task are required");
  if (flags.profile && !state.profiles.includes(flags.profile)) fail(`there is no profile \`${flags.profile}\``);
  const next = Math.max(0, ...state.projects.flatMap((p) => p.threads).map((t) => Number(t.id.slice(2)))) + 1;
  const id = `t-${String(next).padStart(4, "0")}`;
  // `start_pane` stands for the tab Organizations opens: the new node runs in that pane of the FakeHerdr.
  const pane = (project.start_pane ?? { workspace_id: "", tab_id: "", pane_id: "" }) as { workspace_id: string; tab_id: string; pane_id: string };
  project.threads.push({
    id, title: flags.title, parent_id: parent, role, status: pane.pane_id ? "open" : "starting", group: "working", group_label: "Working", note: pane.pane_id ? "" : "starting",
    branch: "", ...pane, cwd: "", updated: new Date().toISOString(), report_unacked: false,
    auto_fix_ci: false, auto_merge: false, pr: null, can_spawn: role === "coordinator" && "can-spawn" in flags,
  });
  delete project.start_pane;
  writeFileSync(file!, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ id, parent_id: parent, role, profile: flags.profile ?? "", pane_id: pane.pane_id }));
}

/**
 * `asks answer`, as Organizations does it: the answer goes to the coordinator, and the line keeps what
 * the coordinator wrote, state included, with `answered_at` until the coordinator changes it.
 */
function answer(slug: string, coordinator: string, line: number, text: string): void {
  const row = [...state.asks!, ...(state.decisions ?? [])]
    .find((candidate) => candidate.project === slug && (candidate.coordinator as { id: string }).id === coordinator && candidate.line === line)
    ?? fail(`line ${line} is not an ask or decision of ${coordinator}`);
  if (!text) fail("the answer is empty");
  if (!(row.actions as string[] | undefined)?.includes("answer")) fail(`${coordinator} takes no answer`);
  row.answered_at = new Date().toISOString();
  writeFileSync(file!, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ schema_version: 1, project: slug, coordinator, line, answered_at: new Date().toISOString() }));
}

/** `node move`: the node, with everything under it, under the project root or an open coordinator not under it. */
function move(slug: string, id: string, parent: string): void {
  const project = state.projects.find((candidate) => candidate.slug === slug) ?? fail(`no project ${slug}`);
  const node = project.threads.find((thread) => thread.id === id) ?? fail(`no node ${id}`);
  if (parent !== "root") {
    const target = project.threads.find((thread) => thread.id === parent) ?? fail(`no node ${parent}`);
    if (target.role !== "coordinator" || target.status === "resolved") fail(`node \`${parent}\` cannot take children`);
    for (let at: FakeThread | undefined = target; at; at = project.threads.find((thread) => thread.id === at!.parent_id)) {
      if (at.id === id) fail(`moving ${id} under ${parent} would make a cycle`);
    }
  }
  node.parent_id = parent;
  writeFileSync(file!, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ schema_version: 1, id, parent_id: parent }));
}

/** `node resolve --close-view`: the node is resolved; its agent and view would stop. */
function resolve(slug: string, id: string): void {
  const project = state.projects.find((candidate) => candidate.slug === slug) ?? fail(`no project ${slug}`);
  const node = project.threads.find((thread) => thread.id === id) ?? fail(`no node ${id}`);
  if (node.status === "resolved") fail(`${id} is already resolved`);
  Object.assign(node, { status: "resolved", group: "resolved", group_label: "Resolved", note: "manual", updated: new Date().toISOString() });
  writeFileSync(file!, JSON.stringify(state, null, 2));
}

/** The project a newer document is about, or the unrecognized-subcommand error of an older Organizations. */
function newer(slug: string | undefined, field: "tasks" | "detail" | "routines" | "projectStatus", word = command): FakeProject {
  const project = state.projects.find((candidate) => candidate.slug === slug) ?? fail(`no project ${slug}`);
  if (project[field] === undefined) fail(`unrecognized subcommand '${word}'`);
  return project;
}

/** `routine set`, as Organizations writes it: only the fields given, a new trigger clearing the other. */
function setRoutine(slug: string | undefined, name: string | undefined, flags: Record<string, string>): void {
  const project = newer(slug, "routines");
  const routine = (project.routines as Array<Record<string, unknown>>).find((candidate) => candidate.name === name) ?? fail(`no routine ${name}`);
  if (flags.schedule !== undefined) Object.assign(routine, { trigger: "schedule", schedule: flags.schedule, events: [] });
  if (flags["on-pr"] !== undefined) Object.assign(routine, { trigger: "pr", schedule: "", events: flags["on-pr"].split(","), last_run: "", next_run: "" });
  if (flags.to !== undefined) Object.assign(routine, { to: flags.to, ...(flags.to === "new" ? {} : { parent: "" }) });
  if (flags.parent !== undefined) routine.parent = flags.parent;
  if (flags.prompt !== undefined) routine.prompt = flags.prompt;
  writeFileSync(file!, JSON.stringify(state));
  console.log(`routine \`${name}\` saved`);
}

const [command, sub] = argv;
const twoWords = ["node", "thread", "profile", "coordinator", "task", "project", "routine"].includes(command ?? "") || (command === "asks" && sub === "answer");
const { flags, positionals } = parse(argv.slice(twoWords ? 2 : 1));
if (command === "overview") {
  console.log(JSON.stringify({ schema_version: 1, projects: state.projects }));
} else if (command === "asks" && sub === "answer") {
  if (state.answers === false || !state.asks) fail("unrecognized subcommand 'answer'");
  if ("help" in flags) console.log("Usage: herdr-organizations asks answer <SLUG> <COORDINATOR> --line <N> --text-file <FILE>");
  else answer(positionals[0]!, positionals[1]!, Number(flags.line), readFileSync(0, "utf8").trim());
} else if (command === "asks" && "json" in flags) {
  if (!state.asks) fail("unrecognized subcommand 'asks'");
  const mine = (row: { project: string }) => !flags.project || row.project === flags.project;
  const decisions = (state.decisions ?? []).filter(mine);
  console.log(JSON.stringify({ schema_version: 1, asks: state.asks.filter(mine), ...(decisions.length ? { decisions } : {}) }));
} else if (command === "profile" && sub === "list" && "names" in flags) {
  console.log(state.profiles.join("\n"));
} else if (command === "profile" && sub === "list" && "json" in flags) {
  if (state.choices === false) fail("unexpected argument '--json' found");
  const project = state.projects.find((candidate) => candidate.slug === flags.project) ?? fail(`no project ${flags.project}`);
  const harnesses = state.profiles.filter((name) => name in EFFORTS).map((harness) => ({ harness, profile: harness, default_model: "", efforts: EFFORTS[harness] }));
  const profiles = [
    ...state.profiles.map((name) => ({ name, harness: name, model: "", reasoning_effort: "", description: "", builtin: true })),
    ...(state.savedProfiles ?? []).map((profile) => ({ ...profile, builtin: false })),
  ];
  const role = { default_profile: project.coordinator_profile ?? state.profiles[0], last: project.last ?? null, harnesses, profiles };
  console.log(JSON.stringify({ schema_version: 1, project: project.slug, coordinator: role, thread: { ...role, last: null } }));
} else if (command === "node" && sub === "start") {
  start(positionals[0]!, flags, flags.role === "coordinator" ? "coordinator" : "worker", flags.parent || "root");
} else if (command === "node" && sub === "move") {
  if (state.moves === false) fail("unrecognized subcommand 'move'");
  if ("help" in flags) console.log("Usage: herdr-organizations node move <SLUG> <ID> --parent <PARENT>");
  else move(positionals[0]!, positionals[1]!, flags.parent ?? fail("--parent is required"));
} else if (command === "node" && sub === "resolve") {
  resolve(positionals[0]!, positionals[1]!);
} else if (command === "coordinator" && sub === "replace") {
  // The FakeHerdr has no pane to start, so the coordinator keeps its pane; the run checks the argv.
  if (!state.projects.some((project) => project.slug === positionals[0])) fail(`no project ${positionals[0]}`);
  const chosen = flags.profile ?? flags.harness ?? "";
  if (!state.profiles.includes(chosen) && !state.savedProfiles?.some((profile) => profile.name === chosen)) fail(`there is no profile \`${chosen}\`; \`profile list\` shows them`);
  console.log(`stopped 1 coordinator agent(s) and started a new one on ${chosen}`);
} else if (command === "task" && sub === "list" && "json" in flags) {
  const project = newer(positionals[0], "tasks");
  console.log(JSON.stringify({ schema_version: 1, project: project.slug, tasks: project.tasks }));
} else if (command === "project" && sub === "show" && "json" in flags) {
  const { threads: _threads, tasks: _tasks, detail, routines: _routines, projectStatus: _status, coordinator: _coordinator, ...project } = newer(positionals[0], "detail");
  console.log(JSON.stringify({ schema_version: 1, project: { ...project, dir: `/srv/projects/${project.slug}`, counts: {}, icon: "", tone: "", ...detail } }));
} else if (command === "project" && sub === "status" && "json" in flags) {
  // An Organizations with `project show` but not `project status` names the subcommand it lacks.
  const project = newer(positionals[0], "projectStatus", "status");
  console.log(JSON.stringify({ schema_version: 1, project: project.slug, ...project.projectStatus }));
} else if (command === "routine" && sub === "list" && "json" in flags) {
  const project = newer(positionals[0], "routines");
  console.log(JSON.stringify({ schema_version: 1, project: project.slug, routine_commands: false, routines: project.routines, broken: [] }));
} else if (command === "routine" && sub === "set") {
  if ("help" in flags) console.log("Usage: herdr-organizations routine set <SLUG> <NAME>");
  else setRoutine(positionals[0], positionals[1], flags);
} else if (command === "open") {
  const project = state.projects.find((candidate) => candidate.slug === positionals[0]) ?? fail(`no project ${positionals[0]}`);
  if (typeof project.open_error === "string") fail(project.open_error);
  const saved = state.savedProfiles?.find((profile) => profile.name === flags.profile);
  const kind = flags.harness ?? saved?.harness ?? flags.profile ?? (typeof project.coordinator_profile === "string" ? project.coordinator_profile : state.profiles[0]);
  if (!state.profiles.includes(kind ?? "")) fail(`there is no profile \`${kind}\`; \`profile list\` shows them`);
  const root = process.env.HERDR_PROJECTS_ROOT;
  if (project.open_pane && root) writeFileSync(`${root}/${project.slug}/.state/coordinator.json`, JSON.stringify({ session: "", ...project.open_pane as object }));
  console.log(`started ${kind} as hp-${positionals[0]}; it reads AGENTS.md and primes itself`);
} else if (command === "thread" && (sub === "pr-action" || sub === "pr-create") && "json" in flags) {
  prAction(sub, positionals[0], positionals[1], positionals[2]);
} else {
  fail(`unrecognized subcommand '${command}'`);
}

/**
 * `thread pr-action` and `thread pr-create`: an action the thread's PR (or, without one, the thread)
 * lists is sent once and then "already asked"; one it does not list, or any on a thread seeded with
 * `refuse`, prints the refusal document and exits 1, as Organizations does when its fresh read of the
 * PR disagrees with the ticker's.
 */
function prAction(sub: string, slug: string | undefined, id: string | undefined, action = "create-pr"): void {
  const project = state.projects.find((candidate) => candidate.slug === slug) ?? fail(`no project ${slug}`);
  const thread = project.threads.find((candidate) => candidate.id === id) ?? fail(`no thread ${id}`);
  const pr = thread.pr as { url: string; actions?: string[] } | null;
  const listed = (pr ? pr.actions : thread.actions as string[] | undefined) ?? [];
  const reason = typeof thread.refuse === "string" ? thread.refuse : listed.includes(action) ? "" : `its pull request does not call for ${action}`;
  const print = (doc: Record<string, unknown>) => console.log(JSON.stringify({ schema_version: 1, id, ...doc }));
  if (reason) {
    console.error(`error: ${reason}`);
    print(sub === "pr-create" ? { ok: false, pr: pr?.url ?? "", reason } : { ok: false, action, pr: pr?.url ?? "", sent: false, message: "", reason });
    process.exit(1);
  }
  if (sub === "pr-create") {
    const next = Math.max(0, ...project.threads.map((t) => Number((t.pr as { url?: string } | null)?.url?.split("/").pop() ?? 0))) + 1;
    const url = `https://github.com/acme/shop/pull/${next}`;
    Object.assign(thread, { actions: [], pr: { url, state: "", review: "", checks: null, additions: null, deletions: null, failing: [], comment_count: null, draft: null, mergeable: null, merge_blocker: "the ticker has not read this pull request yet", actions: [] } });
    writeFileSync(file!, JSON.stringify(state, null, 2));
    print({ ok: true, pr: url, reason: "" });
    return;
  }
  const asked = (thread.asked as string[] | undefined) ?? [];
  if (asked.includes(action)) {
    print({ ok: true, action, pr: pr!.url, sent: false, message: "", reason: "thread pr-action already asked it at 2026-10-10T14:00:00Z about this state of its pull request (commit 0123456)" });
    return;
  }
  thread.asked = [...asked, action];
  writeFileSync(file!, JSON.stringify(state, null, 2));
  print({ ok: true, action, pr: pr!.url, sent: true, message: `Your pull request needs ${action}.`, reason: "" });
}
