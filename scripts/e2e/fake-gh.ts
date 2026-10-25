import { readFileSync } from "node:fs";

// The bench's `gh`: it never reaches GitHub. The bridge asks it one thing, the viewer's open pull
// requests (`gh api … graphql`), and it answers from $NENU_E2E_GH_PRS, a JSON file of rows as
// `gh pr list --json` prints them, wrapped as GitHub's GraphQL answer. Anything else fails.

const file = process.env.NENU_E2E_GH_PRS;
if (!file || process.argv[2] !== "api" || !process.argv.includes("graphql")) {
  console.error("gh stub: no pull requests");
  process.exit(1);
}
const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
const nodes = rows.map(({ statusCheckRollup, ...row }) => ({
  ...row,
  commits: { nodes: [{ commit: { statusCheckRollup: Array.isArray(statusCheckRollup) && statusCheckRollup.length ? { contexts: { nodes: statusCheckRollup } } : null } }] },
}));
console.log(JSON.stringify({ data: { viewer: { pullRequests: { nodes } } } }));
