import { expect, it } from "vitest";

import { ciLabel, ciTone } from "./ci-checks";

it("labels CI by passed checks out of all reported", () => {
  expect(ciLabel(undefined)).toBe("CI");
  expect(ciLabel({ passed: 6, failed: 0, pending: 0 })).toBe("CI 6/6");
});

it("tones CI by its worst check", () => {
  expect(ciTone({ passed: 5, failed: 1, pending: 1 })).toBe("bg-status-blocked");
  expect(ciTone({ passed: 5, failed: 0, pending: 1 })).toBe("bg-status-working");
  expect(ciTone({ passed: 5, failed: 0, pending: 0 })).toBe("bg-status-done");
});
