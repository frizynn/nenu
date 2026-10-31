import { describe, expect, test } from "bun:test";

import { hcSessionName, isHcSession } from "../hc-core.ts";
import { machineGroups } from "./snapshot.ts";

describe("herdr-core's sessions", () => {
  test("each machine has its own, and only they belong together", () => {
    expect(hcSessionName("")).toBe("hc");
    expect(hcSessionName("rise-l")).toBe("hc@rise-l");
    expect(["hc", "hc@rise-l", "default", "hcx", "@rise-l"].filter(isHcSession)).toEqual(["hc", "hc@rise-l"]);
  });

  test("this machine joins Herdr's sessions and hc's; another machine is its hc session", () => {
    const sessions = [{ name: "default", isPrimary: true }, { name: "hc", isPrimary: false }, { name: "hc@rise-l", isPrimary: false }, { name: "work", isPrimary: false }];
    expect(machineGroups(sessions, "macbook")).toEqual([
      { label: "macbook", sessions: ["", "hc", "work"] },
      { label: "rise-l", sessions: ["hc@rise-l"] },
    ]);
  });
});
