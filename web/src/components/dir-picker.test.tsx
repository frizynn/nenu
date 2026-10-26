import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { DirPicker } from "./dir-picker";

// The bridge refuses every listing, as it did over the tailnet before a write-level GET could pass
// without Origin, and the host's home was never learnt.
beforeEach(() => {
  server.use(http.get("/api/dirs", () => new HttpResponse("origin required", { status: 403 })));
});

describe("DirPicker when the bridge will not list", () => {
  it("offers the typed path only once it names a folder, and says so", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<DirPicker home="" shortcuts={[]} onHome={() => undefined} onPick={onPick} />);

    // `~/` cannot be resolved without home, so nothing promises it can be used as typed.
    expect(await screen.findByText("Can't list this folder. Type its full path to use it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this folder" })).toBeDisabled();

    const path = screen.getByLabelText("Folder path");
    await user.clear(path);
    await user.type(path, "/srv/data/");
    expect(await screen.findByText("Can't list this folder. You can still use the path as typed.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use data" }));
    expect(onPick).toHaveBeenCalledWith("/srv/data");
  });
});
