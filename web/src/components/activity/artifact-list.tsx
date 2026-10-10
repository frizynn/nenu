import { ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClock, type ActivityArtifact } from "@/lib/activity";

// claude.ai artifacts are private pages behind the operator's claude.ai session, so Nenu cannot
// frame them; a row opens the link in a new tab instead. Only claude.ai links are ever rendered.
const isClaudeLink = (url: string) => /^https:\/\/claude\.ai\//.test(url);

export function ArtifactRow({ artifact, className }: { artifact: ActivityArtifact; className?: string }) {
  if (!isClaudeLink(artifact.url)) return null;
  return (
    <a
      href={artifact.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-1.5 hover:bg-muted/40", className)}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <ExternalLink aria-hidden="true" className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-snug">
        <span className="truncate text-[12.5px] text-foreground">{artifact.title}</span>
        <span className="truncate text-[11.5px] text-muted-foreground">
          claude.ai artifact · opens in claude.ai{artifact.at !== undefined ? ` · ${formatClock(artifact.at)}` : ""}
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}

export function ArtifactList({ artifacts, className }: { artifacts: ActivityArtifact[]; className?: string }) {
  const shown = artifacts.filter((a) => isClaudeLink(a.url));
  if (!shown.length) return <p className={cn("px-3 py-2 text-xs text-muted-foreground", className)}>No artifacts published in this session.</p>;
  return (
    <ul className={cn("flex flex-col", className)}>
      {shown.map((artifact) => <li key={artifact.id}><ArtifactRow artifact={artifact} /></li>)}
    </ul>
  );
}
