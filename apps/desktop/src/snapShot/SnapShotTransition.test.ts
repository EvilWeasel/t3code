import { afterEach, expect, it, vi } from "vite-plus/test";

const { windows } = vi.hoisted(() => ({ windows: [] as Array<{ destroyed: boolean; webContents: object }> }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class BrowserWindow extends EventEmitter {
    destroyed = false;
    readonly webContents = { executeJavaScript: async () => undefined };
    readonly bounds: object;
    constructor(bounds: object) { super(); this.bounds = bounds; windows.push(this); }
    getBounds() { return this.bounds; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    close() { this.destroy(); }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    showInactive() {}
    async loadURL() {}
  }
  const display = { id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } };
  return { BrowserWindow, screen: { getDisplayMatching: () => display, getAllDisplays: () => [display] } };
});
import { SnapShotTransition } from "./SnapShotTransition.ts";

afterEach(() => { windows.length = 0; });

it("refuses a held creation gate before constructing or loading a native transition window", async () => {
  const transition = new SnapShotTransition({ tryReserveRendererCreation: () => undefined });
  try {
    await expect(transition.begin("capture", { x: 0, y: 0, width: 10, height: 10 }, "data:image/png;base64,AA==", false))
      .rejects.toThrow("creation refused");
    expect(windows).toHaveLength(0);
  } finally { transition.dispose(); }
});

it("binds only its exact same-stack new contents and holds until closed", async () => {
  const bind = vi.fn(() => true);
  const release = vi.fn();
  const transition = new SnapShotTransition({ tryReserveRendererCreation: () => ({ bind, release }) });
  try {
    await transition.begin("capture", { x: 0, y: 0, width: 10, height: 10 }, "data:image/png;base64,AA==", false);
    expect(windows).toHaveLength(1);
    expect(bind).toHaveBeenCalledWith(windows[0]!.webContents);
    expect(release).not.toHaveBeenCalled();
    transition.dispose();
    expect(windows[0]!.destroyed).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  } finally { transition.dispose(); }
});
