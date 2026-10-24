import { paneDiff, paneSessionDiff, type DiffScope } from "../pane-diff.ts";
import type { PaneAction } from "./context.ts";
import { json, jsonError } from "./http.ts";

// `/api/pane/:id/diff?pr=<number>` — what pull request `pr` changes, read from this pane's folder.
// The number is only a lookup in the PRs GitHub reported for that folder's repo; the folder, the
// branches and git's arguments all come from the bridge (pane-diff.ts). Read-level, like the
// pane's files: it shows what is under the pane's folder.
// `/api/pane/:id/diff?scope=branch|uncommitted` — what the pane's session changed, with or without a
// PR. The base comes from the PR of the branch checked out there, else the repo's default.
const SCOPES: readonly DiffScope[] = ["branch", "uncommitted"];

export const diffPaneActions: Record<string, PaneAction> = {
  diff: {
    level: "read",
    marksSeen: false,
    async handle({ pullRequests }, { req, url, rt, paneId }) {
      const current = rt.engine.current();
      const panes = [...current.agents, ...current.shellPanes];
      const cwd = panes.find((entry) => entry.paneId === paneId)?.cwd;
      const scope = url.searchParams.get("scope");
      if (scope !== null) {
        if (!SCOPES.includes(scope as DiffScope)) return jsonError("scope must be branch or uncommitted.", 400, null);
        const diff = await paneSessionDiff(cwd, scope as DiffScope, { base: (folder) => pullRequests.onBranch(folder)?.base });
        return json(diff, req.headers.get("accept-encoding"));
      }
      const number = Number(url.searchParams.get("pr"));
      if (!Number.isSafeInteger(number) || number <= 0) return jsonError("pr must be a pull request number.", 400, null);
      const found = cwd ? pullRequests.locate(cwd, number) : undefined;
      const target = found && { number, head: found.pr.branch, base: found.pr.base, checkedOut: found.checkedOut };
      return json(await paneDiff(cwd, target), req.headers.get("accept-encoding"));
    },
  },
};
