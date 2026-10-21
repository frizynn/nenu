import type { PromptModel } from "@/lib/blocks";

const OPTION_ROW = /^\s*(?:[❯›]\s*)?\d+[.)]\s+(.+)$/;
const FRAME_ROW = /^[\s─━═┌┐└┘├┤┬┴┼╭╮╰╯│┏┓┗┛╔╗╚╝╠╣╦╩╬]+$/;
const labelText = (text: string) => text.trim().replace(/\s+\((?:y|n|esc)\)$/i, "");

/** The grammar already bounded this signed subject; never reach into unrelated pane output. */
export function promptRequestContext(prompt: PromptModel): string {
  if (prompt.family === "select") return "";
  const rows = prompt.signature.split("\n").map((line) => line.trimEnd());
  const firstLabel = prompt.options[0]?.label;
  const optionsStart = firstLabel === undefined ? -1 : rows.findIndex((line) => {
    const option = OPTION_ROW.exec(line)?.[1];
    return option !== undefined && labelText(option) === labelText(firstLabel);
  });
  // If an unfamiliar option shape cannot be separated, preserve the signed context rather than
  // hiding a command or diff. It remains safe native text, with no terminal colours or framing.
  const subject = optionsStart < 0 ? rows : rows.slice(0, optionsStart);
  const content = subject.filter((line) => line.trim() !== prompt.question.trim() && !FRAME_ROW.test(line));
  while (content[0]?.trim() === "") content.shift();
  while (content.at(-1)?.trim() === "") content.pop();
  return content.join("\n");
}

export function PromptRequestContext({ prompt }: { prompt: PromptModel }) {
  const context = promptRequestContext(prompt);
  if (!context) return null;
  return (
    <div aria-label="Request details" className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <div className="mb-1 text-xs font-medium text-muted-foreground">Request details</div>
      <div className="whitespace-pre-wrap break-words text-subhead text-foreground">{context}</div>
    </div>
  );
}
