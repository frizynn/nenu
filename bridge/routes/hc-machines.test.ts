import { describe, expect, test } from "bun:test";

import { hcSessionName, isHcSession } from "../hc-core.ts";
import { hcMachineLabel } from "./snapshot.ts";

describe("herdr-core's sessions", () => {
  test("each machine has its own, and only they belong together", () => {
    expect(hcSessionName("")).toBe("hc");
    expect(hcSessionName("rise-l")).toBe("hc@rise-l");
    expect(["hc", "hc@rise-l", "default", "hcx", "@rise-l"].filter(isHcSession)).toEqual(["hc", "hc@rise-l"]);
  });

  test("a list names this machine by its host and the others by hc's name", () => {
    expect(hcMachineLabel("hc", "macbook")).toBe("macbook");
    expect(hcMachineLabel("hc@rise-l", "macbook")).toBe("rise-l");
  });
});
