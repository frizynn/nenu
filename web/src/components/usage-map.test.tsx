import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ACCOUNTS, day, TODAY, usageOn } from "@/test/usage";
import { ActivityCard, buildMap } from "./usage-map";

const data = usageOn();

describe("buildMap", () => {
  it("lays out 53 Monday-first weeks ending in today's week: 371 squares, the days after today blank", () => {
    const model = buildMap(data);
    expect(model.cells).toHaveLength(371);
    // Monday 12 Oct 2026 starts the last column; today (Wednesday) is its third square.
    expect(model.cells[0]?.date).toBe("2025-10-13");
    expect(model.today).toBe(52 * 7 + 2);
    expect(model.cells[model.today]?.date).toBe(TODAY);
    expect(model.cells.slice(model.today + 1)).toEqual([null, null, null, null]);
    expect(model.activeDays).toBe(5);
  });

  it("puts each day in one of GitHub's four levels by the bridge's quartile cuts, for cost and for tokens", () => {
    const model = buildMap(usageOn({ levels: { cost: [79, 400, 1200], tokens: [1e10, 2e10, 3e10] } }));
    const at = (date: string) => model.cells.find((c) => c?.date === date)!;
    expect(at(TODAY).levels).toEqual([1, 1]);
    expect(at("2026-10-05").levels).toEqual([2, 1]);
    expect(at("2026-10-13").levels).toEqual([4, 1]);
    expect(at("2026-10-07").levels).toEqual([0, 0]);
  });

  it("stripes the days before the oldest log, which Claude Code no longer has, and names them so", () => {
    const model = buildMap(data);
    const at = (date: string) => model.cells.find((c) => c?.date === date)!;
    expect(at("2026-08-31")).toMatchObject({ striped: true, label: "Mon 31 Aug 2026: no logs left" });
    expect(at("2026-09-01")).toMatchObject({ striped: false, label: "Tue 1 Sep 2026: $50, 100M tokens" });
    expect(at("2026-09-02").label).toBe("Wed 2 Sep 2026: no usage");
    expect(at("2026-10-13").label).toBe("Tue 13 Oct 2026: $2,760, 8.9B tokens");
    expect(buildMap(usageOn({ coverage: { logsFrom: "2025-01-01", trackedFrom: "2026-10-01" } })).cells.some((c) => c?.striped)).toBe(false);
  });
});

describe("ActivityCard", () => {
  it("is one listbox of labelled days that the arrow keys walk, a week to each side", async () => {
    render(<ActivityCard model={buildMap(data)} accounts={[]} />);
    const map = screen.getByRole("listbox", { name: /Activity/ });
    expect(within(map).getAllByRole("option")).toHaveLength(52 * 7 + 3);
    map.focus();
    const active = () => document.getElementById(map.getAttribute("aria-activedescendant") ?? "")?.getAttribute("aria-label");
    expect(active()).toBe("Wed 14 Oct 2026: $79, 250M tokens");
    await userEvent.keyboard("{ArrowUp}");
    expect(active()).toBe("Tue 13 Oct 2026: $2,760, 8.9B tokens");
    await userEvent.keyboard("{ArrowLeft}");
    expect(active()).toBe("Tue 6 Oct 2026: no usage");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(active()).toBe("Tue 13 Oct 2026: $2,760, 8.9B tokens");
    await userEvent.keyboard("{Home}");
    expect(active()).toBe("Mon 13 Oct 2025: no logs left");
    await userEvent.keyboard("{End}");
    expect(active()).toBe("Wed 14 Oct 2026: $79, 250M tokens");
  });

  it("details the day under the pointer, the busiest one with its accounts, without redrawing a square", () => {
    const model = buildMap(usageOn({
      days: [...data.days.slice(0, 3), day("2026-10-13", 2760, 8.9e9, { accounts: [
        { id: ACCOUNTS[0]!.id, cost: 1800, tokens: 6e9 }, { id: ACCOUNTS[2]!.id, cost: 960, tokens: 2.9e9 },
      ] }), data.days[4]!],
    }));
    const drawn = vi.spyOn(model.cells, "map");
    render(<ActivityCard model={model} accounts={ACCOUNTS} />);
    expect(drawn).toHaveBeenCalledTimes(1);
    const map = screen.getByRole("listbox", { name: /Activity/ });
    const options = within(map).getAllByRole("option");
    for (const option of options.slice(-20)) fireEvent.pointerOver(option);
    fireEvent.pointerOver(screen.getByRole("option", { name: /^Tue 13 Oct 2026/ }));
    const detail = screen.getByRole("status");
    expect(detail).toHaveTextContent("Tue 13 Oct");
    expect(detail).toHaveTextContent("$2,760");
    expect(detail).toHaveTextContent("8.9B tokens · busiest day");
    expect(detail).toHaveTextContent("Studio$1,800");
    expect(detail).toHaveTextContent("ChatGPT$960");
    expect(drawn).toHaveBeenCalledTimes(1);
  });

  it("draws cost by default and tokens a tap away", async () => {
    const model = buildMap(usageOn({ levels: { cost: [79, 400, 1200], tokens: [1e10, 2e10, 3e10] } }));
    render(<ActivityCard model={model} accounts={[]} />);
    const busiest = screen.getByRole("option", { name: /^Tue 13 Oct 2026/ });
    expect(busiest).toHaveClass("l4");
    await userEvent.click(screen.getByRole("radio", { name: "Tokens" }));
    expect(busiest).toHaveClass("l1");
  });

  it("says how many days had usage and since when, and why the striped days are empty", () => {
    render(<ActivityCard model={buildMap(data)} accounts={[]} />);
    expect(screen.getByText("5 active days · since 1 Sep")).toBeInTheDocument();
    expect(screen.getByText(/Claude Code deletes transcripts after 30 days, so striped days have no logs left/)).toBeInTheDocument();
  });
});
