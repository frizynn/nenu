import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { object } from "../bridge/subagent-files.ts";
import { loadConfig } from "../bridge/config.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function claudeStatuslineSettings(
  settings: unknown,
  executable: string,
  script: string,
  stateDir: string,
) {
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
  if (
    typeof status.command === "string" &&
    status.command.includes("/scripts/claude-statusline.ts")
  )
    return source;
  const command = [
    executable,
    script,
    stateDir,
    typeof status.command === "string" ? status.command : "",
  ]
    .map(quote)
    .join(" ");
  return { ...source, statusLine: { ...status, type: "command", command } };
}

if (import.meta.main) {
  const path =
    process.argv[2] ??
    join(
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      "settings.json",
    );
  const stateDir = process.argv[3] ?? loadConfig().stateDir;
  const before = await readFile(path, "utf8");
  const next =
    JSON.stringify(
      claudeStatuslineSettings(
        JSON.parse(before),
        process.execPath,
        resolve(import.meta.dir, "claude-statusline.ts"),
        stateDir,
      ),
      null,
      2,
    ) + "\n";
  if (before !== next) {
    await writeFile(`${path}.nenu-statusline-backup-${Date.now()}`, before, {
      mode: 0o600,
      flag: "wx",
    });
    const temporary = `${path}.nenu-${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
    if ((await readFile(path, "utf8")) !== before)
      throw new Error("Claude settings changed; retry installation.");
    await rename(temporary, path);
  }
  console.log(
    "Nenu native Claude metrics installed; existing status line preserved.",
  );
}
