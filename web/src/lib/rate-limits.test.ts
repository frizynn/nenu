import { limitRows } from "./rate-limits";
import { resetTime } from "./usage-limit";

const now = new Date(2026, 9, 24, 12, 0).getTime();
const at = (hoursFromNow: number) => (now + hoursFromNow * 3_600_000) / 1000;

it("names the 5-hour window before the weekly one, whatever order the agent reported them in", () => {
  const rows = limitRows([
    { name: "secondary", usedPercent: 99.4, windowMinutes: 10080, resetsAt: at(80) },
    { name: "primary", usedPercent: 51, windowMinutes: 300, resetsAt: at(3) },
  ], now);
  expect(rows).toEqual([
    { key: "primary", label: "5-hour limit", percent: 51, reset: `resets ${resetTime(at(3) * 1000, now)}` },
    { key: "secondary", label: "Weekly limit", percent: 99, reset: `resets ${resetTime(at(80) * 1000, now)}` },
  ]);
  // Another day carries its weekday; today is the clock alone.
  expect(rows[0]!.reset).not.toMatch(/^resets [A-Z][a-z]{2} /);
  expect(rows[1]!.reset).toMatch(/^resets \S+ /);
});

it("draws nothing for an agent that reported no limits", () => {
  expect(limitRows(undefined, now)).toEqual([]);
  expect(limitRows([], now)).toEqual([]);
});

it("drops a reading whose window has reset, and leaves out a reset nobody named", () => {
  expect(limitRows([{ name: "primary", usedPercent: 80, windowMinutes: 300, resetsAt: at(-1) }], now))
    .toEqual([{ key: "primary", label: "5-hour limit", percent: 0, reset: "reset" }]);
  expect(limitRows([{ name: "primary", usedPercent: 12, windowMinutes: 300 }], now))
    .toEqual([{ key: "primary", label: "5-hour limit", percent: 12 }]);
});

it("names other windows by their length, and one with no length plainly", () => {
  expect(limitRows([
    { name: "secondary", usedPercent: 5 },
    { name: "primary", usedPercent: 5, windowMinutes: 2880 },
    { name: "primary", usedPercent: 5, windowMinutes: 120 },
  ], now).map((row) => row.label)).toEqual(["2-hour limit", "2-day limit", "Usage limit"]);
});
