import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, type ReactNode } from "react";
import { vi } from "vitest";

import { chatFileReferences } from "@/lib/chat-files";
import type { TranscriptEntry } from "@/lib/types";
import { ArtifactsPanel } from "./artifacts-panel";

// Artifacts never claims a conversation handed nothing over while it is still checking what it named,
// and checks the names three requests at a time.

const fetchArtifactMetadata = vi.fn();
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchArtifactMetadata: (...args: unknown[]) => fetchArtifactMetadata(...args),
}));

const said = (names: string[]): TranscriptEntry[] => [{ uuid: "a", ts: "", role: "assistant", parts: [{ kind: "text", text: names.map((name) => `Wrote \`${name}\`.`).join(" ") }] }];

beforeEach(() => {
  fetchArtifactMetadata.mockReset();
});

/** What the first commit drew: a parent's layout effect runs before its children's effects can change it. */
function FirstFrame({ seen, children }: { seen: string[]; children: ReactNode }) {
  useLayoutEffect(() => { seen.push(document.body.textContent ?? ""); }, [seen]);
  return children;
}

it("says it is checking, never \"No artifacts\", from its first frame until the bridge answers", () => {
  fetchArtifactMetadata.mockReturnValue(new Promise(() => {}));
  const seen: string[] = [];
  render(<FirstFrame seen={seen}><ArtifactsPanel paneId="w1:p1" references={chatFileReferences(said(["shot.png"]))} ready onOpen={vi.fn()} /></FirstFrame>);
  expect(seen[0]).toContain("Checking files");
  expect(seen[0]).not.toContain("No artifacts");
  expect(screen.getByRole("status")).toHaveTextContent("Checking files");
  expect(screen.queryByText("No artifacts in this conversation")).toBeNull();
});

it("asks about at most three batches of names at once, and starts the next as one lands", async () => {
  let inFlight = 0;
  let most = 0;
  const pending: Array<() => void> = [];
  fetchArtifactMetadata.mockImplementation(() => {
    most = Math.max(most, ++inFlight);
    return new Promise((resolve) => pending.push(() => { inFlight--; resolve([]); }));
  });
  const names = Array.from({ length: 100 }, (_, n) => `page-${n}.html`);
  render(<ArtifactsPanel paneId="w1:p1" references={chatFileReferences(said(names))} ready onOpen={vi.fn()} />);
  // The first 60 names are three batches; checking older ones reads all 100 again, five batches.
  await vi.waitFor(() => expect(pending).toHaveLength(3));
  pending.splice(0).forEach((land) => land());
  await userEvent.click(await screen.findByRole("button", { name: "Check older files" }));
  await vi.waitFor(() => expect(pending).toHaveLength(3));
  expect(fetchArtifactMetadata).toHaveBeenCalledTimes(6);
  pending.shift()!();
  await vi.waitFor(() => expect(fetchArtifactMetadata).toHaveBeenCalledTimes(7));
  expect(most).toBe(3);
  expect(fetchArtifactMetadata.mock.calls.every(([, batch]) => (batch as string[]).length <= 20)).toBe(true);
});
