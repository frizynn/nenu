import { catalogRowFor, modelDisplayName } from "./model-display";
it.each([
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-fable-5-1", "Fable 5.1"],
  ["claude-sonnet-4-20250514", "Sonnet 4"],
  ["claude-3-5-haiku-20241022", "Haiku 3.5"],
  ["gpt-6-astra", "gpt-6-astra"],
  ["custom-model", "custom-model"],
])("displays %s without changing unknown provider names", (input, expected) => {
  expect(modelDisplayName(input)).toBe(expected);
});

it("finds the catalogue row a reported model stands for, and guesses none it does not know", () => {
  const names = ["Default (recommended)", "Opus", "Sonnet", "Fable"];
  expect(catalogRowFor(names, "claude-opus-5-5")).toBe("Opus");
  expect(catalogRowFor(names, "claude-fable-5-1")).toBe("Fable");
  expect(catalogRowFor(["gpt-5.5-codex", "gpt-5.5"], "gpt-5.5")).toBe("gpt-5.5");
  expect(catalogRowFor(names, "custom-model")).toBeUndefined();
  expect(catalogRowFor(names, undefined)).toBeUndefined();
});
