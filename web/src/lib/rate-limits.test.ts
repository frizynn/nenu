import { limitRows, windowLength } from "./rate-limits";
import { resetTime } from "./usage-limit";

const now = new Date(2026, 9, 24, 12, 0).getTime();
const at = (hoursFromNow: number) => (now + hoursFromNow * 3_600_000) / 1000;

it("names the 5-hour window before the weekly one, whatever order the agent reported them in", () => {
  const rows = limitRows([
    { name: "secondary", usedPercent: 99.4, windowMinutes: 10080, resetsAt: at(80) },
    { name: "primary", usedPercent: 51, windowMinutes: 300, resetsAt: at(3) },
  ], now);
  expect(rows).toEqual([
    { key: "primary", label: "5-hour limit", percent: 51, detail: `resets ${resetTime(at(3) * 1000, now)}` },
    { key: "secondary", label: "Weekly limit", percent: 99.4, detail: `resets ${resetTime(at(80) * 1000, now)}` },
  ]);
  // Another day carries its weekday; today is the clock alone.
  const weekday = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { weekday: "short" });
  expect(rows[0]!.detail).not.toContain(weekday(at(3)));
  expect(rows[1]!.detail).toContain(`resets ${weekday(at(80))} `);
});

it("draws nothing for an agent that reported no limits", () => {
  expect(limitRows(undefined, now)).toEqual([]);
  expect(limitRows([], now)).toEqual([]);
});

it("drops the share of a window that has reset since, and any reset nobody named", () => {
  expect(limitRows([{ name: "primary", usedPercent: 80, windowMinutes: 300, resetsAt: at(-1) }], now))
    .toEqual([{ key: "primary", label: "5-hour limit", detail: "Window not started" }]);
  expect(limitRows([{ name: "primary", usedPercent: 12, windowMinutes: 300 }], now))
    .toEqual([{ key: "primary", label: "5-hour limit", percent: 12 }]);
});

it("names any other window by its length", () => {
  expect([300, 10080, 2880, 120, 90, 0, 7.5].map(windowLength)).toEqual(["5-hour", "Weekly", "2-day", "2-hour", "90-minute", "Usage", "Usage"]);
  expect(limitRows([{ name: "primary", usedPercent: 5 }], now)[0]!.label).toBe("Usage limit");
});
