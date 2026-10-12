import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SelectField } from "./select-field";

it("keeps the native select, named by its label, under a chevron a tap passes through", async () => {
  const onChange = vi.fn();
  const { container } = render(
    <label>
      Workspace
      <SelectField value="a" onChange={(event) => onChange(event.target.value)}>
        <option value="a">nenu</option>
        <option value="b">api</option>
      </SelectField>
    </label>,
  );
  const select = screen.getByRole("combobox", { name: "Workspace" });
  await userEvent.selectOptions(select, "b");
  expect(onChange).toHaveBeenCalledWith("b");
  const chevron = container.querySelector("svg")!;
  expect(chevron).toHaveAttribute("aria-hidden", "true");
  expect(chevron).toHaveClass("pointer-events-none");
});
