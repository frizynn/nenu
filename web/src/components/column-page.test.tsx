import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";

import { ColumnPage, PageBody } from "./column-page";
import type { HomeData } from "@/lib/loaders";

const data: HomeData = {
  bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], device: undefined, sessions: [],
  session: undefined, snoozedUntil: null, update: undefined, error: false, authError: false,
};

// What a screen reader and a sighted reader both get: a title faded out is also hidden from AT.
const visible = { ignore: '[aria-hidden="true"], [aria-hidden="true"] *' };
const headerTitle = () => screen.queryByText("Acme Shop", { ...visible, selector: "header *" });

/** Stands in for the browser's IntersectionObserver, which jsdom lacks; `scroll` reports the heading in or out of view. */
function observeIntersections() {
  const watched: Array<{ target: Element; callback: IntersectionObserverCallback; root: Element | Document | null | undefined }> = [];
  vi.stubGlobal("IntersectionObserver", class {
    callback: IntersectionObserverCallback;
    root: Element | Document | null | undefined;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.callback = callback;
      this.root = options?.root;
    }
    observe(target: Element) { watched.push({ target, callback: this.callback, root: this.root }); }
    disconnect() { watched.length = 0; }
    unobserve() {}
    takeRecords() { return []; }
  });
  return {
    watched,
    /** One delivery per observer: several states at once arrive the way a busy page gets them, oldest first. */
    scroll(...inView: boolean[]) {
      act(() => watched.forEach(({ target, callback }) =>
        callback(inView.map((isIntersecting) => ({ target, isIntersecting }) as IntersectionObserverEntry), {} as IntersectionObserver)));
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

function renderPage(path: string, children = <h2>Acme Shop</h2>) {
  return render(<MemoryRouter initialEntries={[path]}><ColumnPage data={data} title="Acme Shop">{children}</ColumnPage></MemoryRouter>);
}

describe("ColumnPage — the large title", () => {
  it("shows the header title only once the page's heading has scrolled under the header", () => {
    const io = observeIntersections();
    renderPage("/settings");
    // The page's own heading is watched inside the page's scroller.
    expect(io.watched.map(({ target }) => target.textContent)).toEqual(["Acme Shop"]);
    expect(io.watched[0]!.root).toBe(screen.getByRole("main"));
    expect(headerTitle()).toBeNull();
    io.scroll(false);
    expect(headerTitle()).toBeInTheDocument();
    io.scroll(true);
    expect(headerTitle()).toBeNull();
  });

  it("goes by the latest of several crossings delivered at once", () => {
    const io = observeIntersections();
    renderPage("/settings");
    // Flung down and back up while the page was busy: the heading ends in view, so the bar stays empty.
    io.scroll(false, true);
    expect(headerTitle()).toBeNull();
    io.scroll(true, false);
    expect(headerTitle()).toBeInTheDocument();
  });

  it("keeps the header title when the page's heading names something else", () => {
    const io = observeIntersections();
    // A page titled by its parent, over its own heading: the bar must not go empty.
    renderPage("/settings/usage", <h2>Rediseño mobile</h2>);
    expect(io.watched).toEqual([]);
    expect(headerTitle()).toBeInTheDocument();
  });

  it("watches the heading that says the title, wherever it sits among the page's headings", () => {
    const io = observeIntersections();
    renderPage("/settings", <><h1>Needs you</h1><h2>Acme Shop</h2></>);
    expect(io.watched.map(({ target }) => target.textContent)).toEqual(["Acme Shop"]);
    expect(headerTitle()).toBeNull();
  });

  it("keeps the header title when the page draws no heading", () => {
    observeIntersections();
    renderPage("/settings", <p>Nothing here yet.</p>);
    expect(headerTitle()).toBeInTheDocument();
  });

  it("keeps the header title where the browser cannot watch the heading", () => {
    renderPage("/settings");
    expect(headerTitle()).toBeInTheDocument();
  });

  it("leads with a back to Home, or to the parent a page names", () => {
    observeIntersections();
    const { unmount } = renderPage("/settings");
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/");
    unmount();
    render(<MemoryRouter initialEntries={["/settings/usage"]}>
      <ColumnPage data={data} title="Acme Shop" back={{ to: "/settings", label: "Acme Shop" }}><h2>Rediseño</h2></ColumnPage>
    </MemoryRouter>);
    expect(screen.getByRole("link", { name: "Back to Acme Shop" })).toHaveAttribute("href", "/settings");
  });
});

describe("ColumnPage — the column", () => {
  it("centres its column in the content area, as Settings and the chat centre theirs", () => {
    renderPage("/");
    const column = screen.getByRole("main").firstElementChild!;
    expect(column).toHaveClass("page-column", "mx-auto");
  });
});

describe("the page's scroll", () => {
  // Two pages that scroll in PageBody: each route its own page.
  const page = (name: string) => <PageBody key={name}><p>{name}</p></PageBody>;
  const scroller = () => document.querySelector("main.page-body") as HTMLElement;
  async function open() {
    const router = createMemoryRouter([{ path: "/asks", element: page("Asks") }, { path: "/node", element: page("Node") }], { initialEntries: ["/asks?q=acme"] });
    render(<RouterProvider router={router} />);
    await screen.findByText("Asks");
    return router;
  }

  it("comes back where it was when the history steps back to it", async () => {
    const router = await open();
    act(() => { scroller().scrollTop = 600; fireEvent.scroll(scroller()); });
    await act(() => router.navigate("/node"));
    expect(scroller().scrollTop).toBe(0);
    await act(() => router.navigate(-1));
    await screen.findByText("Asks");
    expect(scroller().scrollTop).toBe(600);
  });

  it("opens a page it pushes at the top, even one seen before", async () => {
    const router = await open();
    act(() => { scroller().scrollTop = 600; fireEvent.scroll(scroller()); });
    await act(() => router.navigate("/node"));
    await act(() => router.navigate("/asks?q=acme"));
    await screen.findByText("Asks");
    expect(scroller().scrollTop).toBe(0);
  });
});
