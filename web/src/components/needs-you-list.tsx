import { Link, useNavigate } from "react-router";
import { ChevronRight } from "lucide-react";

import { HomeHeading } from "@/components/home-panels";
import { QuestionCard } from "@/components/question-card";
import { StatusDot } from "@/components/status-badge";
import type { InteractionsState, Receipt } from "@/hooks/use-interactions";
import type { NeedsYouItem } from "@/lib/home-stats";
import { panePath } from "@/lib/nav";
import { paneIdentity } from "@/lib/projects";
import type { AgentView, Interaction, ProjectView } from "@/lib/types";

/** Who is asking and where it lives, as Recent names the same pane. */
function asker(agent: AgentView | undefined, projects: readonly ProjectView[] | undefined, paneId: string): { name: string; where?: string } {
  if (!agent) return { name: paneId };
  const { title, place } = paneIdentity(agent, projects);
  return { name: title, where: place };
}

/**
 * Home's "Needs you": each detected dialog as the compact card, answered in place, oldest first. A
 * blocked pane with no dialog the bridge could read is a row into its thread. Answers just sent stay
 * as receipts until the pane's next dialog.
 */
export function NeedsYouList({ agents, projects, session, items, receipts, interactions, readOnly }: {
  agents: readonly AgentView[];
  projects?: readonly ProjectView[];
  session?: string;
  items: readonly NeedsYouItem<Interaction>[];
  receipts: readonly Receipt[];
  interactions: InteractionsState;
  readOnly: boolean;
}) {
  const navigate = useNavigate();
  const byPane = new Map(agents.map((agent) => [agent.paneId, agent]));
  if (!items.length && !receipts.length) return null;

  return (
    <section aria-labelledby="home-needs" className="flex flex-col gap-2.5">
      <HomeHeading id="home-needs" label="Needs you" count={items.length} note={items.length > 1 && "oldest first"} />
      {items.map(({ paneId, interaction }) => {
        const who = asker(byPane.get(paneId), projects, paneId);
        const title = who.where ? `${who.name} · ${who.where}` : who.name;
        if (interaction) {
          return (
            <QuestionCard key={`${paneId}:${interaction.signature}`} compact interaction={interaction} title={title} readOnly={readOnly}
              onOpen={() => navigate(panePath(paneId, session))} onAnswer={(option, extra) => interactions.answer(interaction, option, extra)} />
          );
        }
        return (
          <Link key={paneId} to={panePath(paneId, session)}
            className="flex min-h-12 min-w-0 items-center gap-2.5 rounded-2xl border border-status-blocked/40 bg-status-blocked/[0.06] px-3.5 text-sm">
            <StatusDot status="blocked" surface="bg-card" className="size-2" />
            <span className="shrink-0 font-medium">{who.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{who.where ? `${who.where} · ` : ""}waiting in the terminal</span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        );
      })}
      {receipts.map((receipt) => (
        <QuestionCard key={`receipt:${receipt.paneId}`} compact receipt={receipt} title={asker(byPane.get(receipt.paneId), projects, receipt.paneId).name} onAnswer={() => Promise.resolve({ ok: true })} />
      ))}
    </section>
  );
}
