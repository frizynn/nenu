import { join } from "node:path";
import { MessageQueue, type QueuedMessage } from "./message-queue.ts";
import { deliverQueuedMessage } from "./queue-delivery.ts";
import { computeEtag } from "./http-cache.ts";
import { object } from "./subagent-files.ts";
import type { AgentView, ActionResponse } from "./types.ts";
import type { HerdrClient } from "./herdr-client.ts";

type Context = { pane: AgentView; herdr: HerdrClient; connected: boolean };
const identity = (pane: AgentView) =>
  pane.agentSession?.kind === "id"
    ? `${pane.agent}:${pane.agentSession.value}`
    : null;
const scopeFor = (session: string, pane: AgentView) =>
  computeEtag(JSON.stringify([session, pane.paneId, identity(pane)]));
export class QueueService {
  private queue: MessageQueue;
  constructor(
    stateDir: string,
    private resolve: (
      session: string,
      paneId: string,
      fresh?: boolean,
    ) => Promise<Context | null>,
    private write: (
      row: QueuedMessage,
      text: string,
      submit: boolean,
      id: string,
      paste: boolean,
    ) => Promise<ActionResponse>,
  ) {
    this.queue = new MessageQueue(join(stateDir, "message-queue.json"));
    const timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 2000);
    timer.unref();
  }
  private async tick() {
    await this.queue.tick(
      async (row) => {
        const current = await this.resolve(row.session, row.paneId, true);
        if (!current?.connected || identity(current.pane) !== row.conversation)
          return "unavailable";
        return current.pane.status === "working"
          ? "working"
          : ["idle", "done"].includes(current.pane.status)
            ? "ready"
            : "unavailable";
      },
      async (row) => {
        const current = await this.resolve(row.session, row.paneId, true);
        if (!current?.connected || identity(current.pane) !== row.conversation)
          return {
            status: "blocked",
            error: "The connected conversation changed.",
          };
        return deliverQueuedMessage(
          row,
          current.herdr,
          (text, submit, id, paste) => this.write(row, text, submit, id, paste),
          async () => {
            const next = await this.resolve(row.session, row.paneId, true);
            return (
              !!next?.connected && identity(next.pane) === row.conversation
            );
          },
        );
      },
    );
  }
  async handle(
    req: Request,
    session: string,
    paneId: string,
    device: string | null,
  ): Promise<Response> {
    const current = await this.resolve(session, paneId);
    const conversation = current ? identity(current.pane) : null;
    if (
      !current ||
      !conversation ||
      !["claude", "codex"].includes(current.pane.agent)
    )
      return req.method === "POST"
        ? Response.json(
            {
              error:
                "The connected conversation is unavailable. Your message was not queued.",
            },
            { status: 409 },
          )
        : Response.json({ available: false, messages: [] });
    const scope = scopeFor(session, current.pane);
    try {
      if (req.method === "POST") {
        const body = object(await req.json());
        if (body.scope !== scope)
          return Response.json(
            { error: "The connected conversation changed. Refresh the queue." },
            { status: 409 },
          );
        const id =
          typeof body.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(body.id)
            ? body.id
            : null;
        if (!id)
          return Response.json(
            { error: "Invalid message ID." },
            { status: 400 },
          );
        const text = typeof body.text === "string" ? body.text : "";
        if (
          ["add", "edit"].includes(String(body.action)) &&
          (!text.trim() ||
            text.length > 20_000 ||
            /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x9b]/.test(text))
        )
          return Response.json(
            {
              error:
                "Use a message between 1 and 20,000 characters without terminal controls.",
            },
            { status: 400 },
          );
        if (body.action === "add")
          await this.queue.add({
            id,
            scope,
            session,
            paneId,
            conversation,
            agent: current.pane.agent,
            text,
            device,
          });
        else if (
          ["edit", "remove", "send"].includes(String(body.action)) &&
          typeof body.revision === "number"
        )
          await this.queue.change(
            scope,
            id,
            body.revision,
            body.action as "edit" | "remove" | "send",
            text,
          );
        else
          return Response.json(
            { error: "Invalid queue action." },
            { status: 400 },
          );
      }
      const rows = await this.queue.list(scope);
      return Response.json({
        available: true,
        scope,
        messages: rows.map(
          ({ id, text, state, createdAt, revision, error }) => ({
            id,
            text,
            state,
            createdAt,
            revision,
            error,
          }),
        ),
      });
    } catch {
      return Response.json(
        { error: "Queue could not be updated. Refresh before retrying." },
        { status: 409 },
      );
    }
  }
}
