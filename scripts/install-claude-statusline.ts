import { join } from "node:path";
import { object } from "../bridge/subagent-files.ts";
import { loadConfig } from "../bridge/config.ts";
import { defaultSettingsPath, pluginRoot, updateClaudeSettings } from "./install-claude-hooks.ts";

const WRAPPER = "/scripts/claude-statusline.ts";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const unquoteAll = (command: string) => [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1]!.replaceAll("'\\''", "'"));

/**
 * Wrap the user's status line in Nenu's metrics capture. Re-running it on an already wrapped status
 * line re-points the wrapper (a moved checkout, another state dir) and keeps the user's command.
 */
export function claudeStatuslineSettings(
  settings: unknown,
  executable: string,
  script: string,
  stateDir: string,
): Record<string, unknown> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Invalid Claude settings.");
  const source = object(settings);
  const status = object(source.statusLine);
  if (
    source.statusLine !== undefined &&
    (status.type !== "command" || typeof status.command !== "string")
  )
    throw new Error(
      "Unsupported status line; existing configuration preserved.",
    );
  const current = typeof status.command === "string" ? status.command : "";
  // Our own command is `'<bun>' '<wrapper>' '<state dir>' '<user command>'`; the user's is the 4th.
  const original = current.includes(WRAPPER) ? (unquoteAll(current)[3] ?? "") : current;
  const command = [executable, script, stateDir, original].map(quote).join(" ");
  return { ...source, statusLine: { ...status, type: "command", command } };
}

if (import.meta.main) {
  const path = process.argv[2] ?? defaultSettingsPath();
  const stateDir = process.argv[3] ?? loadConfig().stateDir;
  const script = join(pluginRoot("claude-statusline.ts"), "scripts", "claude-statusline.ts");
  await updateClaudeSettings(
    path,
    (settings) => claudeStatuslineSettings(settings, process.execPath, script, stateDir),
    "nenu-statusline-backup",
  );
  console.log(`Nenu native Claude metrics installed from ${script}; existing status line preserved.`);
}
