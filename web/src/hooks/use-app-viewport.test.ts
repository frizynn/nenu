import { act, renderHook } from "@testing-library/react";
import { useAppViewport } from "./use-app-viewport";

describe("useAppViewport", () => {
  let pending: FrameRequestCallback | undefined;
  let now = 0;
  const flush = () => act(() => { const callback = pending; pending = undefined; callback?.(0); });
  const style = document.documentElement.style;
  const height = () => style.getPropertyValue("--app-viewport-height");
  const top = () => style.getPropertyValue("--app-viewport-top");
  let field: HTMLTextAreaElement;
  let viewport: EventTarget & { height: number; offsetTop: number; scale: number };

  beforeEach(() => {
    viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    vi.stubGlobal("visualViewport", viewport);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { pending = callback; return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => { pending = undefined; });
    vi.spyOn(performance, "now").mockImplementation(() => now);
    now = 0;
    field = document.body.appendChild(document.createElement("textarea"));
  });
  afterEach(() => { field.remove(); pending = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  /** The keyboard up over a focused field, as the viewport reported it. */
  const openKeyboard = () => {
    act(() => field.focus());
    act(() => {
      viewport.height = 480;
      viewport.offsetTop = 40;
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
    });
    flush();
    expect(height()).toBe("480px");
    expect(top()).toBe("40px");
  };

  it("follows the keyboard while a field is focused, holds still under pinch zoom, and cleans up", () => {
    const { unmount } = renderHook(useAppViewport);
    expect(height()).toBe("");
    expect(top()).toBe("0px");
    openKeyboard();

    act(() => {
      viewport.scale = 2;
      viewport.height = 240;
      viewport.dispatchEvent(new Event("resize"));
    });
    flush();
    expect(height()).toBe("480px");
    act(() => {
      viewport.scale = 1;
      viewport.height = 844;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event("resize"));
    });
    flush();
    expect(height()).toBe("844px");
    unmount();
    expect(height()).toBe("");
    expect(top()).toBe("");
    const request = vi.mocked(window.requestAnimationFrame);
    request.mockClear();
    viewport.dispatchEvent(new Event("resize"));
    expect(request).not.toHaveBeenCalled();
  });

  it("gives the app its full height back once the field blurs, though the viewport never says so", () => {
    renderHook(useAppViewport);
    openKeyboard();
    viewport.height = 844;
    viewport.offsetTop = 0;
    act(() => field.blur());
    flush();
    expect(height()).toBe("");
    expect(top()).toBe("0px");
  });

  it("follows an offset iOS leaves behind after the keyboard, read in the frames after the blur", () => {
    renderHook(useAppViewport);
    openKeyboard();
    act(() => field.blur());
    flush();
    viewport.height = 844;
    viewport.offsetTop = 110;
    flush();
    expect(height()).toBe("");
    expect(top()).toBe("110px");
  });

  it("drops a height read while zoomed once no field holds the keyboard, and keeps the offset it had", () => {
    renderHook(useAppViewport);
    openKeyboard();
    act(() => field.blur());
    act(() => {
      viewport.scale = 1.25;
      viewport.height = 675;
      viewport.dispatchEvent(new Event("resize"));
    });
    flush();
    expect(height()).toBe("");
    expect(top()).toBe("40px");
  });

  it("follows the keyboard while a frame holds focus, since its own field may hold the keyboard up", () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    renderHook(useAppViewport);
    act(() => frame.focus());
    act(() => {
      viewport.height = 480;
      viewport.dispatchEvent(new Event("resize"));
    });
    flush();
    expect(height()).toBe("480px");
    frame.remove();
  });

  it.each([
    ["a return to the app", () => document.dispatchEvent(new Event("visibilitychange"))],
    ["a page shown again", () => window.dispatchEvent(new Event("pageshow"))],
    ["a turn of the phone", () => window.dispatchEvent(new Event("resize"))],
  ])("re-reads the viewport on %s with the field still focused", (_, fire) => {
    renderHook(useAppViewport);
    openKeyboard();
    // Past the settle window of the focus, so only the event itself can start a read.
    now += 2000;
    flush();
    viewport.height = 844;
    viewport.offsetTop = 0;
    expect(pending).toBeUndefined();
    act(fire);
    flush();
    expect(height()).toBe("844px");
    expect(top()).toBe("0px");
  });

  it("keeps the CSS viewport fallback when VisualViewport is unavailable", () => {
    vi.stubGlobal("visualViewport", undefined);
    const { unmount } = renderHook(useAppViewport);
    expect(height()).toBe("");
    unmount();
  });
});
