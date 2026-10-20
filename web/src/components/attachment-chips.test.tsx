import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AttachmentChips } from "./attachment-chips";

describe("AttachmentChips", () => {
  // The X stays a small 24px mark; the shared .hit-area gives a touch screen its 44px reach (the
  // workbench.css rule composer-workbench.test.tsx pins). The bench measures the 44x44 on the chip.
  it("gives Remove the app's one 44px touch reach and removes that image", async () => {
    const onRemove = vi.fn();
    render(<AttachmentChips items={[{ id: "a", url: "blob:a", status: "ready", image: true }]} onRemove={onRemove} onRetry={vi.fn()} />);
    const remove = screen.getByRole("button", { name: "Remove Image #1" });
    expect(remove).toHaveClass("hit-area");
    await userEvent.click(remove);
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("names a file by what it is called, with its kind and size; a picture is a thumbnail with its chip's number", () => {
    render(<AttachmentChips onRemove={vi.fn()} onRetry={vi.fn()} items={[
      { id: "a", status: "ready", image: false, name: "brand-guide.pdf", size: 2.4 * 1024 * 1024 },
      { id: "b", status: "ready", image: false, name: "orders-export.csv", size: 18 * 1024 },
      { id: "c", status: "ready", image: true, name: "IMG_2041.jpg", size: 1.1 * 1024 * 1024, url: "blob:c" },
      { id: "d", status: "ready", image: false, name: "Makefile" },
    ]} />);
    const list = screen.getByRole("list", { name: "Attached files" });
    expect(list).toHaveTextContent("brand-guide.pdfPDF · 2.4 MB");
    expect(list).toHaveTextContent("orders-export.csvCSV · 18 KB");
    expect(screen.getByRole("img", { name: "Image #1" })).toHaveTextContent("#1");
    expect(list).not.toHaveTextContent("IMG_2041.jpg");
    expect(list).toHaveTextContent("MakefileFile");
    expect(list.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Remove brand-guide.pdf" })).toBeInTheDocument();
  });
});
