import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import {
  loadAgent,
  loadDirs,
  rememberDir,
  runSpawn,
  saveAgent,
  spawn,
  spawnState,
  suggestDirs,
  PERMISSIONS,
  loadPermission,
  savePermission,
  withDir,
  type SpawnDeps,
  type SpawnInput,
} from "./spawn";

const pane = { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "api", tabId: "w9:t1", cwd: "/srv/api" };
const input = (over: Partial<SpawnInput> = {}): SpawnInput => ({
  target: { kind: "workspace" }, agent: "claude", cwd: " /srv/api ", name: " api ", message: " fix the tests ", permission: "plan", ...over,
});

function deps(over: Partial<SpawnDeps> = {}): SpawnDeps {
  let t = 0;
  return {
    startAgent: vi.fn(async () => ({ ok: true as const })),
    fetchMessageQueue: vi.fn(async () => ({ available: true as const, scope: "s1", messages: [] })),
    changeMessageQueue: vi.fn(async () => ({ available: true as const, scope: "s1", messages: [] })),
    sleep: vi.fn(async (ms: number) => void (t += ms)),
    now: () => t,
    ...over,
  };
}

beforeEach(() => localStorage.clear());

describe("remembered choices", () => {
  it("defaults to Claude and ignores junk", () => {
    expect(loadAgent()).toBe("claude");
    localStorage.setItem("collie.spawn.agent", '"vim"');
    expect(loadAgent()).toBe("claude");
    saveAgent("codex");
    expect(loadAgent()).toBe("codex");
  });

  it("keeps recent dirs newest-first, unique and bounded", () => {
    let dirs: string[] = [];
    for (const d of ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/b", "  "]) dirs = withDir(dirs, d);
    expect(dirs).toEqual(["/b", "/g", "/f", "/e", "/d", "/c"]);
    rememberDir("/a");
    expect(loadDirs()).toEqual(["/a"]);
  });

  it("survives unavailable or corrupt storage", () => {
    localStorage.setItem("collie.spawn.dirs", "{not json");
    expect(loadDirs()).toEqual([]);
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => { saveAgent("shell"); rememberDir("/x"); }).not.toThrow();
    set.mockRestore();
  });

  it("suggests the current dir, then live dirs, then recents, once each and bounded", () => {
    expect(suggestDirs(["/a"], ["/a", "/b"], ["/b", "/c", " "])).toEqual(["/a", "/b", "/c"]);
    expect(suggestDirs([""], ["/1", "/2", "/3", "/4", "/5", "/6"])).toHaveLength(5);
  });

  it("remembers the permission per agent and drops one that is no longer offered", () => {
    expect(loadPermission("claude")).toBe("ask");
    savePermission("claude", "plan");
    savePermission("codex", "full");
    expect([loadPermission("claude"), loadPermission("codex")]).toEqual(["plan", "ask"]); // a dangerous mode is never preselected
    savePermission("codex", "auto");
    expect(loadPermission("codex")).toBe("auto");
    savePermission("claude", "full"); // Codex's id, not Claude's
    expect(loadPermission("claude")).toBe("ask");
    localStorage.setItem("collie.spawn.permission", "[1]");
    expect(loadPermission("codex")).toBe("ask");
  });

  it("offers only choices the bridge allowlists, flagging the dangerous ones", () => {
    expect(PERMISSIONS.claude.map((p) => p.id)).toEqual(["ask", "auto", "acceptEdits", "plan", "bypass"]);
    expect(PERMISSIONS.codex.map((p) => p.id)).toEqual(["ask", "auto", "full"]);
    expect([...PERMISSIONS.claude, ...PERMISSIONS.codex].filter((p) => p.danger).map((p) => p.id)).toEqual(["bypass", "full"]);
  });
});

describe("spawn", () => {
  it("creates a workspace with trimmed label and cwd, then launches the agent and queues the message", async () => {
    let body: unknown;
    server.use(http.post("/api/workspace", async ({ request }) => { body = await request.json(); return HttpResponse.json({ ok: true, pane }); }));
    const d = deps();
    const result = await spawn(input(), d);
    expect(result).toEqual({ ok: true, pane });
    expect(body).toEqual({ label: "api", cwd: "/srv/api" });
    await vi.waitFor(() => expect(spawnState(pane.paneId)?.phase).toBe("done"));
    expect(d.startAgent).toHaveBeenCalledWith("w9:p1", "claude", undefined, "plan");
    expect(d.changeMessageQueue).toHaveBeenCalledWith("w9:p1", expect.objectContaining({ action: "add", scope: "s1", text: "fix the tests" }), undefined);
    expect(loadAgent()).toBe("claude");
    expect(loadPermission("claude")).toBe("plan");
    expect(loadDirs()).toEqual(["/srv/api"]);
  });

  it("creates a tab in the given workspace and leaves a shell alone", async () => {
    let body: unknown;
    server.use(http.post("/api/tab", async ({ request }) => { body = await request.json(); return HttpResponse.json({ ok: true, pane: { ...pane, paneId: "w9:p2" } }); }));
    const d = deps();
    await spawn(input({ target: { kind: "tab", workspaceId: "w9" }, agent: "shell", name: "", cwd: "" }), d);
    expect(body).toEqual({ workspaceId: "w9" });
    expect(d.startAgent).not.toHaveBeenCalled();
    expect(spawnState("w9:p2")).toBeUndefined();
    expect(loadAgent()).toBe("shell");
  });

  it("returns the bridge error and remembers nothing when creation fails", async () => {
    server.use(http.post("/api/workspace", () => HttpResponse.json({ ok: false, error: "No such directory" })));
    expect(await spawn(input(), deps())).toEqual({ ok: false, error: "No such directory" });
    expect(loadDirs()).toEqual([]);
  });
});

describe("runSpawn", () => {
  async function begin(paneId: string, d: SpawnDeps, over: Partial<SpawnInput> = {}) {
    server.use(http.post("/api/workspace", () => HttpResponse.json({ ok: true, pane: { ...pane, paneId } })));
    await spawn(input(over), d);
    await vi.waitFor(() => expect(["done", "error"]).toContain(spawnState(paneId)?.phase));
  }

  it("retries a fast start failure, then succeeds", async () => {
    const start = vi.fn().mockResolvedValueOnce({ ok: false, error: "Open an empty terminal" }).mockResolvedValue({ ok: true });
    await begin("r1", deps({ startAgent: start }), { message: "" });
    expect(start).toHaveBeenCalledTimes(2);
    expect(spawnState("r1")?.phase).toBe("done");
  });

  it("does not launch twice when the first attempt was slow", async () => {
    let t = 0;
    const start = vi.fn(async () => { t += 10_000; return { ok: false as const, error: "timed out" }; });
    await begin("r2", deps({ startAgent: start, now: () => t }), { message: "" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(spawnState("r2")).toMatchObject({ phase: "error", stage: "start", error: "timed out" });
  });

  it("waits for the queue to open, and a retry resumes at the message", async () => {
    let t = 0;
    const fetchQ = vi.fn(async () => ({ available: false as const, messages: [] as [] }));
    const d = deps({ fetchMessageQueue: fetchQ, now: () => t, sleep: async (ms) => void (t += ms) });
    await begin("r3", d);
    expect(spawnState("r3")).toMatchObject({ phase: "error", stage: "queue", message: "fix the tests" });
    expect(d.startAgent).toHaveBeenCalledTimes(1);

    fetchQ.mockResolvedValue({ available: true as never, scope: "s2", messages: [] } as never);
    await runSpawn("r3", d);
    expect(d.startAgent).toHaveBeenCalledTimes(1);
    expect(spawnState("r3")?.phase).toBe("done");
  });
});
