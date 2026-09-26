import { describe, expect, it } from "bun:test";
import { QueueService } from "./queue-service.ts";

describe("unavailable queue", () => {
  const service = new QueueService(
    "/tmp/nenu-unavailable-queue-test",
    async () => null,
    async () => {
      throw new Error("Must not write");
    },
  );
  it("reports availability for reads", async () => {
    const response = await service.handle(
      new Request("http://localhost/queue"),
      "session",
      "pane",
      null,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false, messages: [] });
  });
  it("rejects writes so the caller retains its draft", async () => {
    const response = await service.handle(
      new Request("http://localhost/queue", { method: "POST" }),
      "session",
      "pane",
      null,
    );
    expect(response.status).toBe(409);
  });
});
