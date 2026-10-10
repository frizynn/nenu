import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSocketPath } from "../../bridge/config.ts";
import { assertDisposableSocket, assertTestPort, startTestBridge } from "./bridge.ts";

// The test bridge's whole promise is that it cannot reach the live service or Herdr.

describe("test bridge guards", () => {
  test("refuses the live Nenu port", async () => {
    expect(() => assertTestPort(8787)).toThrow("live Nenu service");
    await expect(startTestBridge({ port: 8787, fake: true })).rejects.toThrow("live Nenu service");
    expect(() => assertTestPort(8797)).not.toThrow();
  });

  test("refuses Herdr's default socket and the named sessions beside it", () => {
    const live = defaultSocketPath();
    expect(() => assertDisposableSocket(live, undefined)).toThrow("default Herdr socket");
    expect(() => assertDisposableSocket(join(live, "..", "sessions", "work", "herdr.sock"), undefined)).toThrow("default Herdr socket");
  });

  test("refuses the shell's inherited HERDR_SOCKET_PATH, accepts a temporary one", () => {
    const inherited = join(tmpdir(), "live-herdr.sock");
    expect(() => assertDisposableSocket(inherited, inherited)).toThrow("HERDR_SOCKET_PATH");
    expect(() => assertDisposableSocket(join(tmpdir(), "nenu-e2e-x", "herdr.sock"), inherited)).not.toThrow();
  });

  test("needs --fake or an explicit disposable socket", async () => {
    await expect(startTestBridge({ port: 8797 })).rejects.toThrow("--fake or --socket");
  });
});
