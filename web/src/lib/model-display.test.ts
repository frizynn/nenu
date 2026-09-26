import { modelDisplayName } from "./model-display";
it.each([
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-sonnet-4-20250514", "Sonnet 4"],
  ["claude-3-5-haiku-20241022", "Haiku 3.5"],
  ["gpt-6-astra", "gpt-6-astra"],
  ["custom-model", "custom-model"],
])("displays %s without changing unknown provider names", (input, expected) => {
  expect(modelDisplayName(input)).toBe(expected);
});
