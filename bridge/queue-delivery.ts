import {
  VERIFY_DELAYS_MS,
  defaultSleep,
  type Sleep,
} from "../web/src/lib/harness/poll.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { QueuedMessage, QueueOutcome } from "./message-queue.ts";
import {
  sendGuardedReply,
  draftCarriesSend,
} from "../web/src/lib/guarded-reply.ts";
import { adapterFor } from "../web/src/lib/harness/index.ts";
import { splitLines } from "../web/src/lib/blocks.ts";
import { parseAnsi } from "../web/src/lib/ansi.ts";
import type { ActionResponse } from "./types.ts";

export async function deliverQueuedMessage(
  row: QueuedMessage,
  herdr: Pick<HerdrClient, "readPane">,
  write: (
    text: string,
    submit: boolean,
    requestId: string,
    paste: boolean,
  ) => Promise<ActionResponse>,
  sameConversation: () => Promise<boolean>,
  sleep: Sleep = defaultSleep,
): Promise<QueueOutcome> {
  const adapter = adapterFor(row.agent);
  if (!adapter?.composerReady)
    return {
      status: "blocked",
      error: "This agent cannot accept queued messages.",
    };
  const read = () => herdr.readPane(row.paneId, "visible", 100, "ansi");
  let initial;
  try {
    initial = splitLines(parseAnsi((await read()).text));
  } catch {
    return {
      status: "blocked",
      error: "Waiting for the terminal connection. Your message is saved.",
    };
  }
  if (
    !adapter.composerReady(initial) ||
    adapter.extractInputDraft(initial)?.trim()
  )
    return {
      status: "blocked",
      error: "The terminal has a dialog or draft. Check it before sending.",
    };
  let writeAttempted = false;
  const result = await sendGuardedReply({
    paneId: row.paneId,
    agent: row.agent,
    text: row.text,
    requestId: `queue:${row.id}:${row.revision}`,
    sleep,
    transport: {
      fetchPane: read,
      async sendReply(_pane, text, submit, _session, _expected, id, paste) {
        if (!(await sameConversation()))
          return { ok: false, error: "The connected conversation changed." };
        const lines = splitLines(parseAnsi((await read()).text));
        const draft = adapter.extractInputDraft(lines);
        if (
          !adapter.composerReady!(lines) ||
          (text
            ? !!draft?.trim()
            : !draftCarriesSend(row.text, draft) &&
              !(draft && adapter.draftCarriesSend?.(row.text, draft)))
        )
          return {
            ok: false,
            error: "The terminal input changed. Check it before sending.",
          };
        writeAttempted = true;
        return write(text, submit, id!, paste ?? false);
      },
    },
  });
  if (result.status === "sent") {
    for (const delay of VERIFY_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      try {
        if (!(await sameConversation())) break;
        const lines = splitLines(parseAnsi((await read()).text));
        if (
          adapter.composerReady(lines) &&
          adapter.extractInputDraft(lines) === null
        )
          return { status: "sent" };
      } catch {
        /* A write acknowledgement alone cannot confirm consumption. */
      }
    }
    return {
      status: "uncertain",
      error:
        "The terminal received Enter, but delivery could not be confirmed. Check Terminal before retrying.",
    };
  }
  return {
    status: !writeAttempted ? "blocked" : "uncertain",
    error: result.error,
  };
}
