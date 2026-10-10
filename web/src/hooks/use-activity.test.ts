import { afterEach, describe, expect, test } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { fakeLiveStream } from "@/test/live-stream";
import { resetLiveEvents } from "@/lib/live-events";
import { fetchTaskOutput, formatCount, formatDuration, runningCount } from "@/lib/activity";
import fixture from "@/components/activity/activity.fixture.json";
import { activityConcerns, useActivity, useWorkflowDetail } from "./use-activity";

afterEach(() => resetLiveEvents());

describe("useActivity", () => {
  test("reads the pane's activity and re-reads on a matching live event only", async () => {
    let reads = 0;
    server.use(http.get("/api/pane/:id/activity", ({ params, request }) => {
      expect(params.id).toBe("w1:p1");
      expect(new URL(request.url).searchParams.get("session")).toBe("work");
      reads++;
      return HttpResponse.json(fixture.list);
    }));
    const live = fakeLiveStream();
    live.open();
    const { result } = renderHook(() => useActivity("w1:p1", "work"));
    await waitFor(() => expect(result.current.data).toEqual(fixture.list));
    expect(reads).toBe(1);
    act(() => live.send({ topic: "journal", paneId: "w2:p9" }));
    act(() => live.send({ topic: "journal", paneId: "w1:p1" }));
    await waitFor(() => expect(reads).toBe(2));
    live.stop();
  });

  test("a failed refresh keeps the last data and marks it stale", async () => {
    let fail = false;
    server.use(http.get("/api/pane/:id/activity", () => fail ? new HttpResponse(null, { status: 503 }) : HttpResponse.json(fixture.list)));
    const { result } = renderHook(() => useActivity("w1:p1"));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    fail = true;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.data).toEqual(fixture.list);
  });

  test("does nothing while disabled", async () => {
    let reads = 0;
    server.use(http.get("/api/pane/:id/activity", () => { reads++; return HttpResponse.json(fixture.list); }));
    renderHook(() => useActivity("w1:p1", undefined, false));
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBe(0);
  });
});

test("useWorkflowDetail asks for one run by id", async () => {
  server.use(http.get("/api/pane/:id/activity", ({ request }) => {
    expect(new URL(request.url).searchParams.get("run")).toBe("wf_58bd2e6c-e80");
    return HttpResponse.json(fixture.detail);
  }));
  const { result } = renderHook(() => useWorkflowDetail("w1:p1", "wf_58bd2e6c-e80"));
  await waitFor(() => expect(result.current.detail?.workflow.runId).toBe("wf_58bd2e6c-e80"));
});

test("fetchTaskOutput names the task, never a path", async () => {
  server.use(http.get("/api/pane/:id/activity", ({ request }) => {
    const params = new URL(request.url).searchParams;
    expect([...params.keys()]).toEqual(["task"]);
    return HttpResponse.json({ sessionKey: "k", id: params.get("task"), text: "out", truncated: false, updatedAt: 1 });
  }));
  await expect(fetchTaskOutput("w1:p1", "b3f8meozt")).resolves.toMatchObject({ id: "b3f8meozt", text: "out" });
});

test("activityConcerns matches its own topic, the pane's journal and a resync", () => {
  expect(activityConcerns({ topic: "resync" }, "p")).toBe(true);
  expect(activityConcerns({ topic: "journal", paneId: "p" }, "p")).toBe(true);
  expect(activityConcerns({ topic: "journal", paneId: "q" }, "p")).toBe(false);
  expect(activityConcerns({ topic: "activity" as "journal", paneId: "p" }, "p")).toBe(true);
  expect(activityConcerns({ topic: "snapshot" }, "p")).toBe(false);
});

test("formatting helpers", () => {
  expect(formatDuration(44_000)).toBe("44s");
  expect(formatDuration(3_437_000)).toBe("57m 17s");
  expect(formatDuration(5_490_000)).toBe("1h 31m");
  expect(formatDuration(undefined)).toBe("");
  expect(formatCount(573_766)).toBe("574k");
  expect(formatCount(1_493_003)).toBe("1.49M");
  expect(runningCount(fixture.list as never)).toBe(2);
});
