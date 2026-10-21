import { HomeHeading, SessionRow, useOpeningPath } from "@/components/home-panels";
import { StatusDot } from "@/components/status-badge";
import { ChatRow } from "@/components/nav-rows";
import { recentChats } from "@/lib/home-stats";
import type { HomeData } from "@/lib/loaders";
import { MACHINE_STATE_WORD as STATE_WORD, otherMachines } from "@/lib/machines";
import type { AgentStatus, MachineState, MachineView } from "@/lib/types";

// The other machines Herdr has saved, each under its own name with its chats, newest first. A row
// opens the chat on its machine (`?s=@<label>`); a machine that is not connected says why instead.
// Loaded only when there is more than one machine (machines-slot.tsx).

// The machine's dot: blocked's red for one that cannot be reached, a grey one while it connects.
const DOT: Record<MachineState, AgentStatus> = {
  connected: "done", connecting: "unknown", offline: "blocked", "old-nenu": "blocked", "no-nenu": "unknown", disabled: "unknown", off: "unknown",
};

const chatsOf = (machine: MachineView) => (machine.herd ? recentChats([...machine.herd.agents, ...machine.herd.shellPanes], undefined, new Set()) : []);

export default function OtherMachines({ data, place }: { data: HomeData; place: "nav" | "home" }) {
  const machines = otherMachines(data);
  return place === "nav"
    ? <>{machines.map((machine) => <NavMachine key={machine.label} machine={machine} />)}</>
    : <>{machines.map((machine) => <HomeMachine key={machine.label} machine={machine} />)}</>;
}

function NavMachine({ machine }: { machine: MachineView }) {
  const now = Date.now();
  const chats = chatsOf(machine);
  const why = machine.state === "connected" ? null : machine.detail ?? STATE_WORD[machine.state];
  return (
    <section aria-label={machine.label} className="nav-group" data-machine>
      <h3 className="nav-label">
        <StatusDot status={DOT[machine.state]} surface="bg-transparent" />
        {machine.label}
        {machine.state === "connected" && chats.length > 0 && <span className="nav-count">{chats.length}</span>}
      </h3>
      {why && <p className="nav-empty">{why}</p>}
      {chats.map((chat) => <ChatRow key={chat.agent.paneId} pane={chat.agent} current={false} now={now} session={machine.session} />)}
    </section>
  );
}

function HomeMachine({ machine }: { machine: MachineView }) {
  const opening = useOpeningPath();
  const now = Date.now();
  const chats = chatsOf(machine);
  const id = `home-machine-${machine.label.replace(/[^\w-]/g, "_")}`;
  const why = machine.state === "connected" ? null : machine.detail ?? STATE_WORD[machine.state];
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5" data-machine>
      <HomeHeading id={id} label={machine.label} count={chats.length || undefined} note={machine.state === "connected" ? undefined : STATE_WORD[machine.state]} />
      {why && <p className="text-footnote text-muted-foreground">{why}</p>}
      {chats.length > 0 && <ul className="flex flex-col">{chats.map((chat) => <SessionRow key={chat.agent.paneId} chat={chat} session={machine.session} now={now} opening={opening} />)}</ul>}
    </section>
  );
}
