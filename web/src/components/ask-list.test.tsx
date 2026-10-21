import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { askSections } from "@/lib/asks";
import type { AskLink, AskRow, AsksList, ProjectView, ThreadReport } from "@/lib/types";
import { server } from "@/test/setup";
import { AskSections } from "./ask-list";

// A question's context, its parts and why a row does not close (ADR 0096), from what the bridge serves
// out of Organizations' asks and a thread's report in the project's records folder.

const PAY = { id: "t-0020", title: "Payments" };
const link = (kind: AskLink["kind"], text: string, extra: Partial<AskLink> = {}): AskLink =>
  ({ kind, text, target: text, thread: "", title: "", state: "", pr: "", prState: "", ...extra });
const ask = (group: AskRow["group"], state: AskRow["state"], line: number, text: string, extra: Partial<AskRow> = {}): AskRow =>
  ({ project: "acme", coordinator: PAY, line, state, text, answer: "", links: [], confirmed: "", mismatch: "", group, ...extra });
const LIST: AsksList = {
  asks: [
    ask("waiting", "needs-decision", 5, "ACM-12 total in instalments", { answer: "3 options, A recommended", answerable: true,
      links: [link("thread", "t-0021", { thread: "t-0021", title: "ACM-12 proposals", state: "resolved" }), link("task", "task:ACM-12", { target: "ACM-12", state: "todo" })] }),
    ask("unclosed", "done", 6, "Coupons in the cart", { answer: "merged", mismatch: "a linked task is still to do",
      links: [link("pr", "https://github.com/acme/shop/pull/1360", { state: "merged", thread: "t-0022" }), link("task", "task:ACM-9", { target: "ACM-9", title: "Coupons: apply the discount at checkout", state: "todo" })] }),
  ],
  decisions: [
    { project: "acme", coordinator: PAY, line: 14, text: "ACM-12 instalments: A, B or C", links: [link("page", "https://tracker.example.com/12")], group: "waiting", answerable: true },
    { project: "acme", coordinator: PAY, line: 15, text: "ACM-12 tell yesterday's 412 orders", links: [], group: "waiting", answerable: true },
  ],
  answers: true,
};
const REPORT: ThreadReport = {
  title: "ACM-12 proposals", verdict: "needs-decision",
  text: "Status: needs-decision\n\n## Summary\nPick one.\n\n## Report\n**The question.** Show the total?\n\n| | A | B |\n| --- | --- | --- |\n| Drop-off | -20 % | -8 % |\n\n## Captures\n- today.png - Today",
  captures: [{ path: "/records/acme/library/t-0021/today.png", caption: "Today at 390" }], deliverables: [],
};
const project = (paneId?: string): ProjectView => ({ slug: "acme", name: "Acme", status: "active",
  threads: [{ id: "t-0020", title: "Payments", parentId: "root", role: "coordinator", status: "open", ...(paneId ? { paneId } : {}) }] });

function setup({ paneId, readOnly = false }: { paneId?: string; readOnly?: boolean } = {}) {
  const reads: string[] = [];
  const sent: Array<{ pane: string; text: string }> = [];
  server.use(
    http.get("/api/org/report", ({ request }) => {
      reads.push(new URL(request.url).search);
      return HttpResponse.json({ ok: true, report: REPORT });
    }),
    http.post("/api/pane/:paneId/send", async ({ params, request }) => {
      const body = await request.json() as { text: string; requestId: string };
      sent.push({ pane: String(params.paneId), text: body.text });
      return HttpResponse.json({ ok: true, requestId: body.requestId, ack: "submitted" });
    }),
  );
  const sections = askSections(LIST, [project(paneId)]);
  const router = createMemoryRouter([{ path: "*", element: <AskSections sections={sections} whose answers readOnly={readOnly} /> }]);
  render(<RouterProvider router={router} />);
  return { reads, sent, user: userEvent.setup() };
}

it("reads an ask and the decisions about the same task as one question, each part with its own Answer", () => {
  setup();
  const waiting = screen.getByRole("region", { name: "Waiting on you" });
  expect(within(waiting).getAllByRole("link", { name: /ACM-12/ })).toHaveLength(1);
  const parts = within(waiting).getByRole("list", { name: "Parts of this question" });
  expect(Array.from(parts.children, (part) => part.firstChild?.textContent)).toEqual(["instalments: A, B or C", "tell yesterday's 412 orders"]);
  expect(within(waiting).getAllByRole("button", { name: /^Answer/ }).map((button) => button.getAttribute("aria-label"))).toEqual([
    "Answer ACM-12 instalments: A, B or C", "Answer ACM-12 tell yesterday's 412 orders", "Answer ACM-12 total in instalments",
  ]);
});

it("opens a question's context in place: the whole report with its table and its captures, and Answer at its foot", async () => {
  const { reads, user } = setup();
  const waiting = screen.getByRole("region", { name: "Waiting on you" });
  await user.click(within(waiting).getByRole("button", { name: "Context" }));
  const context = await within(waiting).findByRole("region", { name: "Context" });
  await within(context).findByRole("table");
  expect(reads).toEqual(["?project=acme&thread=t-0021"]);
  expect(within(context).getByRole("link", { name: "ACM-12 proposals" })).toHaveAttribute("href", "/project/acme/node/t-0021");
  expect(context).toHaveTextContent("Asks for your decision");
  expect(within(context).getByRole("columnheader", { name: "A" })).toBeInTheDocument();
  expect(within(context).getByRole("cell", { name: "-20 %" })).toBeInTheDocument();
  // The Status line and the captures list are not drawn as text: the gallery shows them.
  expect(context).not.toHaveTextContent("Status: needs-decision");
  expect(context).not.toHaveTextContent("today.png - Today");
  expect(within(context).getByRole("img", { name: "Today at 390" }))
    .toHaveAttribute("src", `/api/org/library?project=acme&path=${encodeURIComponent("/records/acme/library/t-0021/today.png")}`);
  await user.click(within(context).getByRole("button", { name: "Answer ACM-12 total in instalments" }));
  expect(within(context).getByLabelText("Your answer")).toBeInTheDocument();
});

it("says what does not close and where, and asks its coordinator after a confirm", async () => {
  const { sent, user } = setup({ paneId: "w1:coord" });
  const unclosed = screen.getByRole("region", { name: "Does not close" });
  expect(unclosed).toHaveTextContent("Marked done, but task ACM-9 is still to do.");
  expect(unclosed).toHaveTextContent("Coupons: apply the discount at checkout");
  await user.click(within(unclosed).getByRole("button", { name: "Ask the coordinator" }));
  const dialog = await screen.findByRole("dialog", { name: "Ask the coordinator?" });
  expect(sent).toEqual([]);
  await user.click(within(dialog).getByRole("button", { name: "Ask the coordinator" }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({ pane: "w1:coord", text: expect.stringContaining('line 6 under "## Asked" is marked done, but task ACM-9 is still to do') });
  expect(sent[0]!.text).not.toContain("Coupons in the cart");
  expect(await within(unclosed).findByText("Asked its coordinator.")).toBeInTheDocument();
});

it("offers no ask where its coordinator is not running, or to a read-only device", () => {
  setup();
  expect(within(screen.getByRole("region", { name: "Does not close" })).queryByRole("button", { name: "Ask the coordinator" })).not.toBeInTheDocument();
});

it("sends nothing from a read-only device", () => {
  setup({ paneId: "w1:coord", readOnly: true });
  expect(within(screen.getByRole("region", { name: "Does not close" })).queryByRole("button", { name: "Ask the coordinator" })).not.toBeInTheDocument();
});

it("draws no chip for a task the tracker does not have, and says so in its context", async () => {
  const list: AsksList = { asks: [ask("waiting", "needs-decision", 5, "Launch the sweep fix (task sweep-trabajo-vivo)", { answerable: true,
    links: [link("task", "task:sweep-trabajo-vivo", { target: "sweep-trabajo-vivo", state: "missing" })] })], decisions: [], answers: true };
  const router = createMemoryRouter([{ path: "*", element: <AskSections sections={askSections(list, [project()])} whose answers readOnly={false} /> }]);
  render(<RouterProvider router={router} />);
  expect(screen.queryByRole("list", { name: "Links" })).not.toBeInTheDocument();
  expect(screen.queryByText("missing")).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Context" }));
  expect(await screen.findByText(/not in the tracker/)).toBeInTheDocument();
});
