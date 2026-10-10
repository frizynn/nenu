import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

// A stand-in for the herdr-organizations CLI, for the e2e bench only. The bridge spawns it through a
// shell stub (bridge.ts); it keeps its projects in the JSON file $NENU_E2E_ORG, prints the `--json`
// documents the bridge reads (Organizations docs/json.md), and appends every argv to
// $NENU_E2E_ORG.calls so a run can report exactly what Nenu asked for. It reaches no Herdr.

interface FakeThread { id: string; title: string; parent_id: string; role: "worker" | "coordinator"; status: string; [key: string]: unknown }
interface FakeState { profiles: string[]; projects: Array<{ slug: string; threads: FakeThread[]; [key: string]: unknown }> }

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
  project.threads.push({
    id, title: flags.title, parent_id: parent, role, status: "starting", group: "working", group_label: "Working", note: "starting",
    branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: new Date().toISOString(), report_unacked: false,
    auto_fix_ci: false, auto_merge: false, pr: null,
  });
  writeFileSync(file!, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ id, parent_id: parent, role, profile: flags.profile ?? "", pane_id: "" }));
}

const [command, sub] = argv;
const { flags, positionals } = parse(argv.slice(command === "node" || command === "thread" || command === "profile" ? 2 : 1));
if (command === "overview") {
  console.log(JSON.stringify({ schema_version: 1, projects: state.projects }));
} else if (command === "profile" && sub === "list" && "names" in flags) {
  console.log(state.profiles.join("\n"));
} else if (command === "node" && sub === "start") {
  start(positionals[0]!, flags, flags.role === "coordinator" ? "coordinator" : "worker", flags.parent || "root");
} else if (command === "open") {
  if (!state.projects.some((project) => project.slug === positionals[0])) fail(`no project ${positionals[0]}`);
  console.log(`started claude as hp-${positionals[0]}; it reads AGENTS.md and primes itself`);
} else {
  fail(`unrecognized subcommand '${command}'`);
}
