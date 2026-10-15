/** Synthetic Namespace qualification, importing production logic without starting desktop main/backend. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import {
  app,
  BrowserWindow,
  Menu,
  session,
  type WebContents,
  type MenuItemConstructorOptions,
} from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as DesktopChannel from "../../../server/src/preview/DesktopBrowserChannel.ts";
import * as ServerBrowser from "../../../server/src/preview/ServerBrowser.ts";
import { SessionControl } from "../../../server/src/preview/SessionControl.ts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PreviewManager from "../../src/preview/Manager.ts";
import * as BrowserSession from "../../src/preview/BrowserSession.ts";
import * as DesktopBrowserHost from "../../src/preview/DesktopBrowserHost.ts";
import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../../src/telemetry/DesktopRendererHistory.ts";
import * as ElectronDialog from "../../src/electron/ElectronDialog.ts";
import * as PreviewPasskeys from "../../src/preview/Passkeys.ts";
import { makeAutofill, makeBindingStore } from "../../src/preview/ProtonPassAutofill.ts";
import { makeAutofillMenu } from "../../src/preview/ProtonPassAutofillMenu.ts";
import { ProtonPassUnavailable, type ProtonPassProvider } from "../../src/preview/ProtonPassCli.ts";

const hash = (value: NodeJS.ArrayBufferView | string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (
    !key ||
    !value ||
    !["--output", "--temporary", "--binding", "--repo"].includes(key) ||
    flags.has(key) ||
    !NodePath.isAbsolute(value)
  )
    throw new Error("Invalid child arguments");
  flags.set(key, value);
}
if (
  flags.size !== 4 ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.MORROWBYTE_NAMESPACE_PROFILE !== "namespace-profile-ci-builder" ||
  process.env.MORROWBYTE_NAMESPACE_PROBE !== "1" ||
  process.getuid?.() === 0
)
  throw new Error("Namespace child required");
const output = flags.get("--output")!;
const temporary = flags.get("--temporary")!;
const repo = flags.get("--repo")!;
if (NodeFS.readFileSync(NodePath.join(temporary, ".owned"), "utf8") !== "synthetic-autofill-only")
  throw new Error("Unowned temporary root");
const binding = JSON.parse(NodeFS.readFileSync(flags.get("--binding")!, "utf8")) as {
  source: string;
  lockSha256: string;
  runId: string;
  executable: string;
  executableSha256: string;
  entrySha256: string;
};
const required = [
  "runtime",
  "nativeMenuLinkFill",
  "nativeMenuRefill",
  "focusIdentity",
  "clearRevealedPair",
  "replacementRefusal",
  "foreignDocumentRefusal",
  "formMismatchRefusal",
  "profileIsolation",
  "exactOrigin",
  "subframe",
  "incognito",
  "lockedStates",
  "unlink",
  "pendingRead",
  "pendingFocus",
  "pendingInsert",
  "navigationRead",
  "navigationFocus",
  "redirect",
  "privateAdmissions",
  "privateCdp",
  "publicRelayEvents",
  "privateEvents",
  "lateReply",
  "annotationCancellation",
  "recordingRefusal",
  "devtoolsRefusal",
  "agentOwnedPreEntry",
  "viewerOwnedPreEntry",
  "unsupportedAuthority",
] as const;
type Check = (typeof required)[number];
const checks: Record<string, "UNKNOWN_REQUIRED" | "PASS" | "FAIL"> = Object.fromEntries(
  required.map((name) => [name, "UNKNOWN_REQUIRED"]),
);
type FocusPhase =
  | "idle"
  | "blur-before"
  | "blur-after"
  | "owner-focus-before"
  | "owner-focus-after"
  | "guest-focus-before"
  | "guest-focus-after"
  | "windowfocus-before"
  | "windowfocus-callback"
  | "windowfocus-after"
  | "key-before"
  | "key-callback"
  | "key-after"
  | "field-js-before"
  | "field-js-after"
  | "page-event-before"
  | "page-event-observed"
  | "identity-before"
  | "identity-after";
type FatalCategory =
  | "child-watchdog"
  | "uncaught-exception"
  | "unhandled-rejection"
  | "main-rejected"
  | "os-spawn-failed"
  | "os-command-failed"
  | "focus-identity-failed"
  | "focus-operation-failed"
  | "receipt-write-failed";
type OsStatus = {
  operation: "windowfocus" | "key";
  pid: number | null;
  window: number;
  xid: number;
  completed: boolean;
  exited: boolean;
  closed: boolean;
  exitCode: number | null;
  signal: "SIGTERM" | "SIGKILL" | "other" | null;
  timedOut: boolean | null;
  spawnFailure: boolean;
  callbackSucceeded: boolean | null;
};
const receipt = {
  binding,
  runtime: {
    electron: process.versions.electron ?? "",
    executable: NodeFS.realpathSync(process.execPath),
    sha256: hash(NodeFS.readFileSync(process.execPath)),
  },
  checks,
  ids: [] as { window: number; webContents: number; mainFrame: number; subframes: number[] }[],
  counts: {
    nativeMenus: 0,
    nativeSelections: 0,
    osCommands: 0,
    credentialReads: 0,
    blockedNetwork: 0,
  },
  privateCliAcceptance: "NOT_EXERCISED",
  officialExtensionSupport: "UNKNOWN",
  agentOwnerBoundary: "UNREACHABLE_PUBLIC_MANAGER_STATE",
  activeCheck: "startup",
  focus: {
    subphase: "idle" as FocusPhase,
    window: null as number | null,
    webContents: null as number | null,
    mainFrame: null as number | null,
    sameWindow: null as boolean | null,
    sameWebContents: null as boolean | null,
    sameMainFrame: null as boolean | null,
    documentUnchanged: null as boolean | null,
    ownerFocused: null as boolean | null,
    guestFocused: null as boolean | null,
    fieldIdentityMatched: null as boolean | null,
    pageEventObserved: false,
  },
  os: null as OsStatus | null,
  fatalCategory: null as FatalCategory | null,
  fatalSubphase: null as FocusPhase | null,
  diagnosticsWriteFailed: false,
  phase: "partial",
  cleanup: "not-started",
  fatal: false,
  passed: false,
};
let partialFrozen = false;
const flush = (partial: boolean) => {
  if (partial && partialFrozen) return;
  const name = NodePath.join(
    output,
    partial ? "fixture-receipt.partial.json" : "fixture-receipt.json",
  );
  const pending = `${name}.tmp`;
  try {
    const fd = NodeFS.openSync(pending, "w", 0o600);
    try {
      NodeFS.writeFileSync(fd, JSON.stringify(receipt, null, 2));
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
    NodeFS.renameSync(pending, name);
    const directory = NodeFS.openSync(output, "r");
    try {
      NodeFS.fsyncSync(directory);
    } finally {
      NodeFS.closeSync(directory);
    }
  } finally {
    if (NodeFS.existsSync(pending)) NodeFS.unlinkSync(pending);
  }
};
const latchFatal = (category: FatalCategory) => {
  if (receipt.fatalCategory !== null) return;
  receipt.fatal = true;
  receipt.passed = false;
  receipt.fatalCategory = category;
  receipt.fatalSubphase = receipt.focus.subphase;
  try {
    flush(true);
  } catch {
    receipt.diagnosticsWriteFailed = true;
  }
  partialFrozen = true;
};
const assertRunning = () => {
  if (receipt.fatal || finishing) throw new Error("Fixture stopped");
};
const progress = (subphase: FocusPhase) => {
  assertRunning();
  receipt.focus.subphase = subphase;
  flush(true);
};
// Own this before creating ANY windows: receipts must survive last-window destruction.
app.on("window-all-closed", () => {});
app.setPath("userData", NodePath.join(temporary, "user-data"));
app.setPath("sessionData", NodePath.join(temporary, "session-data"));
const windows: BrowserWindow[] = [];
const servers: NodeHttp.Server[] = [];
const releases = new Set<() => void>();
const ownedOs = new Map<NodeChildProcess.ChildProcess, Promise<void>>();
let finishing = false;
let watchdog: ReturnType<typeof setTimeout>;
async function finish(fatal: boolean, category: FatalCategory = "main-rejected") {
  if (fatal) latchFatal(category);
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  receipt.fatal ||= fatal;
  receipt.cleanup = "pending";
  try {
    flush(true);
  } catch {
    receipt.diagnosticsWriteFailed = true;
    latchFatal("receipt-write-failed");
  }
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const pendingOs = [...ownedOs.entries()];
        for (const [child] of pendingOs) child.kill("SIGKILL");
        for (const window of windows) if (!window.isDestroyed()) window.destroy();
        for (const release of releases) release();
        await Promise.all(pendingOs.map(([, closed]) => closed));
        await Promise.all(
          servers.map(
            (server) =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
        );
        receipt.cleanup = "complete";
      })(),
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(() => {
          receipt.cleanup = "timed-out";
          resolve();
        }, 8000);
      }),
    ]);
  } catch {
    receipt.cleanup = "failed";
  } finally {
    clearTimeout(cleanupTimer);
  }
  receipt.phase = "final";
  receipt.passed =
    !receipt.fatal &&
    receipt.cleanup === "complete" &&
    receipt.counts.blockedNetwork === 0 &&
    required.every((name) => checks[name] === "PASS");
  try {
    flush(false);
  } catch {
    receipt.passed = false;
  }
  app.exit(receipt.passed ? 0 : 1);
}
watchdog = setTimeout(() => {
  void finish(true, "child-watchdog");
}, 120000);
process.on("uncaughtException", () => {
  void finish(true, "uncaught-exception");
});
process.on("unhandledRejection", () => {
  void finish(true, "unhandled-rejection");
});

const deferred = <T>() => Promise.withResolvers<T>();
const events = new Map<string, ReturnType<typeof deferred<void>>>();
const gates = new Map<string, ReturnType<typeof deferred<void>>>();
const event = (id: string) => {
  const pending = deferred<void>();
  events.set(id, pending);
  return pending.promise;
};
const gate = (id: string) => {
  const started = event(id);
  const pending = deferred<void>();
  gates.set(id, pending);
  const release = () => {
    pending.resolve();
    releases.delete(release);
    gates.delete(id);
  };
  releases.add(release);
  return { started, release };
};
const check = async (id: Check, operation: () => Promise<boolean>) => {
  if (finishing) throw new Error("Finishing");
  receipt.activeCheck = id;
  try {
    const passed = await operation();
    assertRunning();
    checks[id] = passed ? "PASS" : "FAIL";
  } catch {
    if (!receipt.fatal) checks[id] = "FAIL";
  }
  if (!receipt.fatal) receipt.activeCheck = "between-checks";
};
const rejected = async (operation: Promise<unknown>) => {
  try {
    await operation;
    return false;
  } catch {
    return true;
  }
};
const os = async (window: BrowserWindow, keys: readonly string[]) => {
  assertRunning();
  const native = window.getNativeWindowHandle();
  const xid = native.length >= 8 ? Number(native.readBigUInt64LE()) : native.readUInt32LE();
  if (!Number.isSafeInteger(xid) || xid <= 0 || window.isDestroyed()) {
    void finish(true, "focus-identity-failed");
    throw new Error("Missing owned window");
  }
  const normalizeSignal = (signal: NodeJS.Signals | null): OsStatus["signal"] =>
    signal === null ? null : signal === "SIGTERM" || signal === "SIGKILL" ? signal : "other";
  const call = (operation: OsStatus["operation"], args: string[]) =>
    new Promise<void>((resolve, reject) => {
      assertRunning();
      const status: OsStatus = {
        operation,
        pid: null,
        window: window.id,
        xid,
        completed: false,
        exited: false,
        closed: false,
        exitCode: null,
        signal: null,
        // execFile's internal timeout is not observable; neither duration nor error.killed proves it.
        timedOut: null,
        spawnFailure: false,
        callbackSucceeded: null,
      };
      receipt.os = status;
      receipt.counts.osCommands += 1;
      progress(operation === "windowfocus" ? "windowfocus-before" : "key-before");
      const closed = deferred<void>();
      let child: NodeChildProcess.ChildProcess;
      let spawned = false;
      try {
        child = NodeChildProcess.execFile(
          "/usr/bin/xdotool",
          args,
          {
            timeout: 5000,
            env: {
              PATH: "/usr/bin:/bin",
              DISPLAY: process.env.DISPLAY!,
              XAUTHORITY: process.env.XAUTHORITY!,
            },
          },
          (error) => {
            status.completed = true;
            status.callbackSucceeded = error === null;
            if (!receipt.fatal && !finishing)
              progress(operation === "windowfocus" ? "windowfocus-callback" : "key-callback");
            if (error || receipt.fatal || finishing) {
              if (error)
                void finish(true, status.spawnFailure ? "os-spawn-failed" : "os-command-failed");
              reject(new Error("Owned X11 input failed"));
            } else resolve();
          },
        );
      } catch {
        status.spawnFailure = true;
        void finish(true, "os-spawn-failed");
        reject(new Error("Owned X11 spawn failed"));
        return;
      }
      ownedOs.set(child, closed.promise);
      child.once("spawn", () => {
        spawned = true;
        status.pid = child.pid ?? null;
        if (receipt.fatal || finishing) child.kill("SIGKILL");
        else flush(true);
      });
      child.once("error", () => {
        status.spawnFailure = !spawned;
        void finish(true, spawned ? "os-command-failed" : "os-spawn-failed");
      });
      child.once("exit", (code, signal) => {
        status.exited = true;
        status.exitCode = code;
        status.signal = normalizeSignal(signal);
        if (!receipt.fatal) flush(true);
      });
      child.once("close", (code, signal) => {
        status.closed = true;
        status.exitCode = code;
        status.signal = normalizeSignal(signal);
        ownedOs.delete(child);
        closed.resolve();
        if (!receipt.fatal) flush(true);
      });
    });
  await call("windowfocus", ["windowfocus", "--sync", String(xid)]);
  progress("windowfocus-after");
  if (keys.length) {
    await call("key", ["key", "--clearmodifiers", ...keys]);
    progress("key-after");
  }
};

let primary = "";
let secondary = "";
const hostPages = new Map<string, { partition: string; url: string }>();
const preload = NodePath.join(repo, "apps/desktop/dist-electron/preview-pick-preload.cjs");
const html =
  () => `<!doctype html><html><head><meta charset="utf-8"><style nonce="fixture">body{font:18px sans-serif;margin:30px}input{display:block;margin:12px;height:36px}iframe{width:300px;height:180px}</style></head><body><form id="a"><input id="u" type="text" autocomplete="username"><input id="p" type="password"></form><form id="b"><input id="u2" type="text"><input id="p2" type="password"></form><iframe src="${secondary}/frame"></iframe><iframe id="same-origin" src="${primary}/frame"></iframe><script nonce="fixture">
  document.querySelectorAll('input').forEach(input => input.addEventListener('focus', () => fetch('/event/focus-' + input.id, {method:'POST'})));
  new MutationObserver(() => { if(document.documentElement.hasAttribute('data-t3code-annotation-tool')) fetch('/event/overlay', {method:'POST'}); }).observe(document.documentElement,{attributes:true});
</script></body></html>`;
async function serve() {
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const id = url.pathname.split("/")[2] ?? "";
    if (
      (url.pathname.startsWith("/event/") || url.pathname.startsWith("/gate/")) &&
      /^[a-z0-9-]{1,64}$/.test(id)
    ) {
      events.get(id)?.resolve();
      const held = gates.get(id);
      if (held) {
        void held.promise.then(() => {
          response.writeHead(204);
          response.end();
        });
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: `${primary}/login` });
      response.end();
      return;
    }
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-fixture'; style-src 'nonce-fixture'; frame-src ${primary} ${secondary}; connect-src ${primary} ${secondary}; img-src ${primary} ${secondary}`,
    );
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const page = hostPages.get(url.pathname);
    if (url.pathname === "/frame") {
      response.end('<!doctype html><input id="frame-login" type="text"><input type="password">');
      return;
    }
    response.end(
      page
        ? `<!doctype html><title>Morrowbyte owned autofill fixture</title><style nonce="fixture">html,body,webview{width:100%;height:100%;margin:0;display:flex}</style><webview partition="${page.partition}" src="${page.url}" preload="file://${preload}"></webview>`
        : html(),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback bind failed");
  return `http://127.0.0.1:${address.port}`;
}
const securedSessions = new WeakSet<Electron.Session>();
async function constrain(browserSession: Electron.Session) {
  if (securedSessions.has(browserSession)) return;
  securedSessions.add(browserSession);
  await browserSession.setProxy({ mode: "direct" });
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = details.url === "about:blank" || details.url.startsWith("devtools://devtools/");
    try {
      allowed ||= [primary, secondary].includes(new URL(details.url).origin);
    } catch {}
    if (!allowed) receipt.counts.blockedNetwork += 1;
    callback({ cancel: !allowed });
  });
}

async function exercise(
  manager: PreviewManager.PreviewManager["Service"],
  host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  profiles: BrowserSession.BrowserSession["Service"],
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  replies: Map<number, { privateEntry: boolean; success: boolean }>,
  cdpEvents: { count: number },
  connection: DesktopBrowserHost.DesktopBrowserConnection,
  nativeTabs: Map<string, { control: SessionControl; desktop: object | null; closing: boolean }>,
  controlChanged: (key: { threadId: string; tabId: string }) => void,
  refusals: Map<string, string>,
) {
  const makeGuest = async (
    id: string,
    profile: string,
    persistent = true,
    agentId: string | null = null,
  ) => {
    assertRunning();
    const key = { threadId: "fixture-thread", tabId: id };
    const control = new SessionControl(agentId, () => controlChanged(key));
    nativeTabs.set(id, { control, desktop: {}, closing: false });
    const authorityAttached = event(`authority-attached-${id}`);
    const partition = await run(profiles.getPartition(profile, persistent, "profile"));
    await constrain(await run(profiles.getSession(profile, persistent, "profile")));
    assertRunning();
    const owner = new BrowserWindow({
      width: 940,
      height: 760,
      show: true,
      title: "Morrowbyte owned autofill fixture",
      webPreferences: {
        webviewTag: true,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    windows.push(owner);
    await run(manager.setMainWindow(owner));
    const attached = deferred<WebContents>();
    owner.webContents.once("did-attach-webview", (_event, guest) => attached.resolve(guest));
    hostPages.set(`/host-${id}`, { partition, url: `${primary}/login` });
    assertRunning();
    const load = owner.loadURL(`${primary}/host-${id}`);
    const wc = await attached.promise;
    const ready = deferred<void>();
    wc.once("did-finish-load", () => ready.resolve());
    await load;
    await ready.promise;
    await run(manager.createTab(id, { serverTab: { threadId: "fixture-thread", tabId: id } }));
    await run(manager.registerWebview(id, wc.id));
    await run(manager.setColorScheme(id, "light"));
    host.attach(
      { threadId: "fixture-thread", tabId: id },
      { webContents: wc, debugger: wc.debugger },
    );
    await authorityAttached;
    receipt.ids.push({
      window: owner.id,
      webContents: wc.id,
      mainFrame: wc.mainFrame.routingId,
      subframes: wc.mainFrame.frames.map((frame) => frame.routingId),
    });
    return { owner, wc, id, partition, control };
  };
  type Guest = Awaited<ReturnType<typeof makeGuest>>;
  const focus = async (guest: Guest, field = "u") => {
    assertRunning();
    const frame = guest.wc.mainFrame;
    let navigationObserved = false;
    const navigating = () => {
      navigationObserved = true;
      if (!receipt.fatal && !finishing) {
        receipt.focus.documentUnchanged = false;
        flush(true);
      }
    };
    guest.wc.on("did-start-navigation", navigating);
    receipt.focus.window = guest.owner.id;
    receipt.focus.webContents = guest.wc.id;
    receipt.focus.mainFrame = frame.routingId;
    receipt.focus.fieldIdentityMatched = null;
    receipt.focus.pageEventObserved = false;
    const mark = (phase: FocusPhase) => {
      assertRunning();
      receipt.focus.sameWindow =
        !guest.owner.isDestroyed() && guest.owner.id === receipt.focus.window;
      receipt.focus.sameWebContents =
        !guest.wc.isDestroyed() && guest.wc.id === receipt.focus.webContents;
      receipt.focus.sameMainFrame =
        !guest.wc.isDestroyed() && !frame.isDestroyed() && guest.wc.mainFrame === frame;
      receipt.focus.documentUnchanged = !navigationObserved;
      receipt.focus.ownerFocused = !guest.owner.isDestroyed() && guest.owner.isFocused();
      receipt.focus.guestFocused = !guest.wc.isDestroyed() && guest.wc.isFocused();
      progress(phase);
    };
    try {
      mark("blur-before");
      await guest.wc.executeJavaScript("document.activeElement?.blur()");
      mark("blur-after");
      const observed = event(`focus-${field}`).then(() => {
        if (!receipt.fatal && !finishing) {
          receipt.focus.pageEventObserved = true;
          flush(true);
        }
      });
      mark("owner-focus-before");
      guest.owner.focus();
      mark("owner-focus-after");
      mark("guest-focus-before");
      guest.wc.focus();
      mark("guest-focus-after");
      await os(guest.owner, []);
      mark("field-js-before");
      const actual = await guest.wc.executeJavaScript(
        `document.getElementById(${JSON.stringify(field)}).focus(); document.activeElement.id`,
      );
      assertRunning();
      receipt.focus.fieldIdentityMatched = actual === field;
      mark("field-js-after");
      mark("page-event-before");
      await observed;
      mark("page-event-observed");
      mark("identity-before");
      const valid = actual === field && guest.wc.isFocused() && guest.owner.isFocused();
      mark("identity-after");
      if (!valid) {
        void finish(true, "focus-identity-failed");
        throw new Error("Owned focus identity failed");
      }
      return valid;
    } catch {
      void finish(true, "focus-operation-failed");
      throw new Error("Owned focus operation failed");
    } finally {
      guest.wc.off("did-start-navigation", navigating);
    }
  };
  const target = async (guest: Guest) => {
    const current = await run(manager.getAutofillTarget(guest.wc, guest.wc.mainFrame));
    if (!current) throw new Error("Autofill target unavailable");
    return current;
  };
  const observer = async (guest: Guest, expectedEmpty: boolean) =>
    guest.wc.executeJavaScriptInIsolatedWorld(1004, [
      {
        code: expectedEmpty
          ? `document.getElementById('u').value === '' && document.getElementById('p').value === ''`
          : `(async()=>{const digest=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');return await digest(document.getElementById('u').value)==='${hash(username)}' && await digest(document.getElementById('p').value)==='${hash(password)}';})()`,
      },
    ]);
  const username = NodeCrypto.randomBytes(18).toString("hex");
  const password = NodeCrypto.randomBytes(24).toString("hex");
  let pendingRead: ReturnType<typeof deferred<void>> | undefined;
  let readStarted: ReturnType<typeof deferred<void>> | undefined;
  let mode: "ready" | "locked" | "signed-out" | "unsupported" = "ready";
  let activeGuest: Guest;
  const provider: ProtonPassProvider = {
    async vaults() {
      if (mode !== "ready") throw new ProtonPassUnavailable(mode);
      return [{ shareId: "fixture-vault", title: "Owned synthetic vault" }];
    },
    async logins() {
      return [{ shareId: "fixture-vault", itemId: "fixture-item", title: "Owned synthetic login" }];
    },
    async credentials(selected) {
      assertRunning();
      if (selected.shareId !== "fixture-vault" || selected.itemId !== "fixture-item")
        throw new Error("Unexpected selected reference");
      if (!host.isPrivateEntry(activeGuest.wc)) throw new Error("Read before private gate");
      receipt.counts.credentialReads += 1;
      readStarted?.resolve();
      if (pendingRead) await pendingRead.promise;
      assertRunning();
      return { username, password };
    },
  };
  const store = makeBindingStore(NodePath.join(temporary, "bindings.json"));
  const service = makeAutofill(provider, store);
  const reference = {
    shareId: "fixture-vault",
    itemId: "fixture-item",
    title: "Owned synthetic login",
  };
  const A = await makeGuest("fixture-a", "A");
  activeGuest = A;
  const nativeChoice = async (
    guest: Guest,
    template: MenuItemConstructorOptions[],
    keys: string[],
  ) => {
    assertRunning();
    const done = deferred<void>();
    const wrap = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
      items.map((item) => ({
        ...item,
        ...(Array.isArray(item.submenu) ? { submenu: wrap(item.submenu) } : {}),
        ...(item.click
          ? {
              click: async (...args: Parameters<NonNullable<typeof item.click>>) => {
                receipt.counts.nativeSelections += 1;
                try {
                  assertRunning();
                  await item.click!(...args);
                  assertRunning();
                  done.resolve();
                } catch {
                  done.reject(new Error("Native action failed"));
                }
              },
            }
          : {}),
      }));
    const menu = Menu.buildFromTemplate(wrap(template));
    receipt.counts.nativeMenus += 1;
    menu.once("menu-will-show", () => {
      void os(guest.owner, keys).catch(() => done.reject(new Error("Native menu input failed")));
    });
    assertRunning();
    menu.popup({ window: guest.owner });
    await done.promise;
  };
  let notices = 0;
  let staticNotice = false;
  const menuUi = (guest: Guest) => ({
    restoreFocus() {
      assertRunning();
      guest.owner.focus();
      guest.wc.focus();
    },
    async notice(message: string) {
      notices += 1;
      staticNotice =
        message.includes(mode) && !message.includes(username) && !message.includes(password);
    },
    async choose(_title: string, choices: readonly string[]) {
      const chosen = deferred<number>();
      await nativeChoice(
        guest,
        choices.map((choice, index) => ({ label: choice, click: () => chosen.resolve(index) })),
        ["Down", "Return"],
      );
      return chosen.promise;
    },
  });
  const cdp = async (id: number, method: string, params: object = {}, browser = false) =>
    run(
      connection.handleCommandLine(
        JSON.stringify({
          type: "cdp",
          threadId: "fixture-thread",
          tabId: A.id,
          message: JSON.stringify({
            id,
            method,
            params,
            ...(browser ? {} : { sessionId: "t3-preview-page" }),
          }),
        }),
      ),
    );
  const waitReply = async (id: number) => {
    // Real stream publishes FIFO; the request has an explicit event waiter, never a polling pass condition.
    if (replies.has(id)) return;
    await event(`reply-${id}`);
  };
  await check("publicRelayEvents", async () => {
    await cdp(
      90,
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      true,
    );
    await waitReply(90);
    await cdp(91, "Runtime.enable");
    await waitReply(91);
    if (!replies.get(90)?.success || !replies.get(91)?.success) return false;
    const relayed = event("public-console");
    const before = cdpEvents.count;
    await A.wc.executeJavaScript("console.log('owned-public-baseline')");
    await relayed;
    return cdpEvents.count > before;
  });
  await check("focusIdentity", () => focus(A));
  await check("nativeMenuLinkFill", async () => {
    const current = await target(A);
    const menu = await makeAutofillMenu(current, service, menuUi(A));
    await nativeChoice(A, menu, ["Down", "Right", "Return"]);
    return (
      receipt.counts.nativeMenus === 3 &&
      receipt.counts.nativeSelections === 3 &&
      host.isPrivateEntry(A.wc) &&
      (await observer(A, false)) === true
    );
  });
  const freshClear = async (guest: Guest) => {
    await focus(guest);
    await service.clearAndResume(await target(guest));
  };
  await check("privateAdmissions", async () => {
    const operations = [
      manager.captureScreenshot(A.id).pipe(Effect.asVoid),
      manager.startRecording(A.id),
      manager.openPictureInPicture(A.id),
      manager.pickElement(A.id).pipe(Effect.asVoid),
      manager.setColorScheme(A.id, "dark"),
    ];
    return (
      (await Promise.all(operations.map((operation) => rejected(run(operation))))).every(Boolean) &&
      host.isPrivateEntry(A.wc)
    );
  });
  await check("privateCdp", async () => {
    await cdp(100, "DOM.getDocument");
    await waitReply(100);
    return replies.get(100)?.privateEntry === true;
  });
  if (checks.publicRelayEvents === "PASS")
    await check("privateEvents", async () => {
      const before = cdpEvents.count;
      const emitted = deferred<void>();
      const listener = (_event: Electron.Event, method: string) => {
        if (method === "Runtime.consoleAPICalled") emitted.resolve();
      };
      A.wc.debugger.on("message", listener);
      await A.wc.debugger.sendCommand("Runtime.enable");
      await A.wc.executeJavaScript("console.log('owned-fixture-event')");
      await emitted.promise;
      await cdp(101, "DOM.getDocument");
      await waitReply(101);
      A.wc.debugger.off("message", listener);
      return cdpEvents.count === before;
    });
  await check("clearRevealedPair", async () => {
    await A.wc.executeJavaScript(
      "document.getElementById('p').type='text'; document.getElementById('u2').focus()",
    );
    const different = await target(A);
    const refused = await rejected(different.enterPrivate());
    await focus(A);
    await nativeChoice(A, await makeAutofillMenu(await target(A), service, menuUi(A)), [
      "Down",
      "Right",
      "End",
      "Return",
    ]);
    return refused && (await observer(A, true)) === true && !host.isPrivateEntry(A.wc);
  });
  await check("nativeMenuRefill", async () => {
    await A.wc.executeJavaScript("document.getElementById('p').type='password'");
    await focus(A);
    const before = receipt.counts.credentialReads;
    await nativeChoice(A, await makeAutofillMenu(await target(A), service, menuUi(A)), [
      "Down",
      "Right",
      "Return",
    ]);
    const filled =
      receipt.counts.credentialReads === before + 1 && (await observer(A, false)) === true;
    await freshClear(A);
    return filled;
  });
  await check("profileIsolation", async () => {
    await A.wc.session.cookies.set({ url: primary, name: "owned-fixture-profile", value: "A" });
    const B = await makeGuest("fixture-b", "B");
    await focus(B);
    const foreign = await target(B);
    const before = receipt.counts.credentialReads;
    return (
      (await B.wc.session.cookies.get({ url: primary, name: "owned-fixture-profile" })).length ===
        0 &&
      (await A.wc.session.cookies.get({ url: primary, name: "owned-fixture-profile" })).length ===
        1 &&
      A.wc.session.getStoragePath()?.startsWith(temporary) === true &&
      B.wc.session.getStoragePath()?.startsWith(temporary) === true &&
      A.wc.session !== B.wc.session &&
      A.partition !== B.partition &&
      (await service.linked(foreign)).length === 0 &&
      (await rejected(service.fill(foreign, reference))) &&
      receipt.counts.credentialReads === before
    );
  });
  await focus(A);
  activeGuest = A;
  await check("exactOrigin", async () => {
    const changed = deferred<void>();
    A.wc.once("did-finish-load", () => changed.resolve());
    await A.wc.loadURL(`${secondary}/login`);
    await changed.promise;
    await focus(A);
    const before = receipt.counts.credentialReads;
    const foreign = await target(A);
    const result =
      (await service.linked(foreign)).length === 0 &&
      (await rejected(service.fill(foreign, reference))) &&
      receipt.counts.credentialReads === before;
    await A.wc.loadURL(`${primary}/login`);
    await focus(A);
    return result;
  });
  await check("subframe", async () => {
    const frame = A.wc.mainFrame.frames[0];
    return (
      !!frame &&
      frame.origin === secondary &&
      frame !== A.wc.mainFrame &&
      (await run(manager.getAutofillTarget(A.wc, frame))) === undefined
    );
  });
  await check("incognito", async () => {
    const guest = await makeGuest("fixture-incognito", "incognito", false);
    await focus(guest);
    return (
      (await guest.wc.session.cookies.get({ url: primary, name: "owned-fixture-profile" }))
        .length === 0 &&
      guest.wc.session.getStoragePath() === null &&
      (await run(manager.getAutofillTarget(guest.wc, guest.wc.mainFrame))) === undefined
    );
  });
  await focus(A);
  activeGuest = A;
  await check("lockedStates", async () => {
    const before = receipt.counts.credentialReads;
    for (const state of ["locked", "signed-out", "unsupported"] as const) {
      mode = state;
      const current = await target(A);
      const beforeNotice = notices;
      staticNotice = false;
      await nativeChoice(A, await makeAutofillMenu(current, service, menuUi(A)), [
        "Down",
        "Right",
        "End",
        "Return",
      ]);
      if (notices !== beforeNotice + 1 || !staticNotice || !host.isPrivateEntry(A.wc)) return false;
      await freshClear(A);
    }
    mode = "ready";
    return receipt.counts.credentialReads === before;
  });
  await check("pendingRead", async () => {
    readStarted = deferred<void>();
    pendingRead = deferred<void>();
    const current = await target(A);
    const filling = service.fill(current, reference);
    await readStarted.promise;
    const blocked =
      (await rejected(service.clearAndResume(current))) &&
      (await rejected(current.clearAndResume())) &&
      host.isPrivateEntry(A.wc);
    pendingRead.resolve();
    await filling;
    pendingRead = undefined;
    readStarted = undefined;
    await freshClear(A);
    return blocked && (await observer(A, true)) === true;
  });
  for (const kind of ["Focus", "Insert"] as const)
    await check(`pending${kind}`, async () => {
      const held = gate(`native-${kind.toLowerCase()}`);
      const current = await target(A);
      await A.wc.executeJavaScript(
        `document.getElementById('p').addEventListener('${kind === "Focus" ? "focus" : "input"}',()=>{const r=new XMLHttpRequest();r.open('POST','/gate/native-${kind.toLowerCase()}',false);r.send();},{once:true})`,
      );
      let settled = false;
      const filling = service.fill(current, reference).finally(() => {
        settled = true;
      });
      await held.started;
      const blocked =
        !settled && (await rejected(current.clearAndResume())) && host.isPrivateEntry(A.wc);
      held.release();
      await filling;
      await freshClear(A);
      return blocked && (await observer(A, true)) === true;
    });
  for (const [index, kind] of (
    ["replacementRefusal", "foreignDocumentRefusal", "formMismatchRefusal"] as const
  ).entries())
    await check(kind, async () => {
      await service.fill(await target(A), reference);
      await A.wc.executeJavaScriptInIsolatedWorld(1004, [
        {
          code: "globalThis.fixtureRetained={username:document.getElementById('u'),password:document.getElementById('p')};true",
        },
      ]);
      const mutation =
        kind === "replacementRefusal"
          ? "const old=document.getElementById('p');const clone=old.cloneNode(true);clone.value=old.value;old.replaceWith(clone);"
          : kind === "foreignDocumentRefusal"
            ? "document.getElementById('same-origin').contentDocument.body.append(document.getElementById('a'));"
            : "document.getElementById('b').append(document.getElementById('p'));";
      await A.wc.executeJavaScript(mutation);
      if (kind === "replacementRefusal")
        await A.wc.executeJavaScriptInIsolatedWorld(1004, [
          { code: "globalThis.fixtureRetained.replacement=document.getElementById('p');true" },
        ]);
      const unchanged = async () =>
        A.wc.executeJavaScriptInIsolatedWorld(1004, [
          {
            code: `(async()=>{
        const r=globalThis.fixtureRetained;
        const digest=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
        const values=await digest(r.username.value)==='${hash(username)}' && await digest(r.password.value)==='${hash(password)}' && (!r.replacement || await digest(r.replacement.value)==='${hash(password)}');
        const boundary=${kind === "replacementRefusal" ? "!r.password.isConnected && r.replacement.isConnected && r.replacement!==r.password" : kind === "foreignDocumentRefusal" ? "r.username instanceof HTMLInputElement && r.password instanceof HTMLInputElement && r.username!==r.password && r.username.isConnected && r.password.isConnected && r.username.form===r.password.form && r.username.form.isConnected && r.username.form.contains(r.username) && r.username.form.contains(r.password) && r.username.ownerDocument!==document && r.password.ownerDocument!==document && r.username.ownerDocument===r.password.ownerDocument" : "r.username.isConnected && r.password.isConnected && r.username.ownerDocument===document && r.password.ownerDocument===document && r.username.form!==r.password.form"};
        return values && boundary;
      })()`,
          },
        ]);
      if ((await unchanged()) !== true) return false;
      await focus(A, kind === "foreignDocumentRefusal" ? "u2" : "u");
      const gatesClosed = async (id: number) => {
        if (!host.isPrivateEntry(A.wc)) return false;
        const capture = await rejected(run(manager.captureScreenshot(A.id)));
        await cdp(id, "DOM.getDocument");
        await waitReply(id);
        return capture && replies.get(id)?.privateEntry === true && host.isPrivateEntry(A.wc);
      };
      const first =
        (await rejected(service.clearAndResume(await target(A)))) &&
        (await unchanged()) === true &&
        (await gatesClosed(300 + index * 2));
      const second =
        (await rejected(service.clearAndResume(await target(A)))) &&
        (await unchanged()) === true &&
        (await gatesClosed(301 + index * 2));
      await A.wc.loadURL(`${primary}/login`);
      await focus(A);
      await freshClear(A);
      return first && second;
    });
  for (const kind of ["navigationRead", "redirect"] as const)
    await check(kind, async () => {
      readStarted = deferred<void>();
      pendingRead = deferred<void>();
      const old = await target(A);
      const filling = service.fill(old, reference);
      await readStarted.promise;
      await A.wc.loadURL(`${primary}/${kind === "redirect" ? "redirect" : "login"}`);
      await focus(A);
      pendingRead.resolve();
      const refused = await rejected(filling);
      pendingRead = undefined;
      readStarted = undefined;
      const remained =
        host.isPrivateEntry(A.wc) && !old.current() && (await observer(A, true)) === true;
      await freshClear(A);
      return refused && remained;
    });
  await check("navigationFocus", async () => {
    const held = gate("navigation-focus");
    await A.wc.executeJavaScript(
      "document.getElementById('p').addEventListener('focus',()=>{const r=new XMLHttpRequest();r.open('POST','/gate/navigation-focus',false);r.send();},{once:true})",
    );
    const old = await target(A);
    const filling = service.fill(old, reference);
    await held.started;
    const navigation = deferred<void>();
    A.wc.once("did-start-navigation", () => navigation.resolve());
    const loading = A.wc.loadURL(`${primary}/login`);
    await navigation.promise;
    held.release();
    const refused = await rejected(filling);
    await loading;
    await focus(A);
    const remained =
      host.isPrivateEntry(A.wc) && !old.current() && (await observer(A, true)) === true;
    await freshClear(A);
    return refused && remained;
  });
  await check("devtoolsRefusal", async () => {
    const opened = deferred<void>();
    A.wc.once("devtools-opened", () => opened.resolve());
    A.wc.openDevTools({ mode: "detach", activate: false });
    await opened.promise;
    const result = (await run(manager.getAutofillTarget(A.wc, A.wc.mainFrame))) === undefined;
    const closed = deferred<void>();
    A.wc.once("devtools-closed", () => closed.resolve());
    A.wc.closeDevTools();
    await closed.promise;
    await focus(A);
    return result;
  });
  await check("recordingRefusal", async () => {
    await run(manager.startRecording(A.id));
    const result = (await run(manager.getAutofillTarget(A.wc, A.wc.mainFrame))) === undefined;
    await run(manager.stopRecording(A.id));
    return result;
  });
  await focus(A);
  if (connection.dispatchCommandLine)
    await check("lateReply", async () => {
      const started = event("late-command-started");
      const pending = await run(
        connection.dispatchCommandLine!(
          JSON.stringify({
            type: "cdp",
            threadId: "fixture-thread",
            tabId: A.id,
            message: JSON.stringify({
              id: 200,
              method: "Runtime.evaluate",
              sessionId: "t3-preview-page",
              params: {
                expression:
                  "new Promise(resolve=>{globalThis.ownedLateResolve=()=>resolve(true);fetch('/event/late-command-started',{method:'POST'})})",
                awaitPromise: true,
                returnByValue: true,
              },
            }),
          }),
        ),
      );
      if (!pending) return false;
      await started;
      activeGuest = A;
      await service.fill(await target(A), reference);
      const privateBefore = host.isPrivateEntry(A.wc);
      await freshClear(A);
      await A.wc.executeJavaScript(
        "globalThis.ownedLateResolve();delete globalThis.ownedLateResolve",
      );
      // This is the captured old command's actual reply/suppression boundary, not another command.
      await pending.settled;
      await cdp(201, "DOM.enable");
      await waitReply(201);
      return (
        privateBefore &&
        !host.isPrivateEntry(A.wc) &&
        !replies.has(200) &&
        replies.get(201)?.success === true
      );
    });
  await check("annotationCancellation", async () => {
    await focus(A);
    const current = await target(A);
    const overlay = event("overlay");
    const editor = event("annotation-editor");
    await A.wc.executeJavaScript(
      "document.addEventListener('focusin',e=>{if(e.target instanceof Element && e.target.closest('[data-t3code-annotation-ui]'))fetch('/event/annotation-editor',{method:'POST'})})",
    );
    const captured = deferred<boolean>();
    let picking: Promise<unknown>;
    const onPicked = (ipc: Electron.IpcMainEvent) => {
      if (ipc.sender.id !== A.wc.id || ipc.senderFrame !== A.wc.mainFrame) {
        captured.resolve(false);
        return;
      }
      void (async () => {
        const refusedBefore =
          (await rejected(current.enterPrivate())) && !host.isPrivateEntry(A.wc);
        await run(manager.cancelPickElement(A.id));
        const cancelled = (await picking) === null;
        const refusedAfter = (await rejected(current.enterPrivate())) && !host.isPrivateEntry(A.wc);
        captured.resolve(refusedBefore && cancelled && refusedAfter);
      })().catch(() => captured.resolve(false));
    };
    A.wc.ipc.once("preview:element-picked", onPicked);
    picking = run(manager.pickElement(A.id));
    await overlay;
    const point = (await A.wc.executeJavaScript(
      "(()=>{const r=document.getElementById('u').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
    )) as { x: number; y: number };
    const bounds = A.owner.getContentBounds();
    if (
      !Number.isInteger(point.x) ||
      !Number.isInteger(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= bounds.width ||
      point.y >= bounds.height
    )
      return false;
    await os(A.owner, []);
    receipt.counts.osCommands += 1;
    await new Promise<void>((resolve, reject) =>
      NodeChildProcess.execFile(
        "/usr/bin/xdotool",
        [
          "mousemove",
          "--sync",
          String(bounds.x + point.x),
          String(bounds.y + point.y),
          "click",
          "1",
        ],
        {
          timeout: 5000,
          env: {
            PATH: "/usr/bin:/bin",
            DISPLAY: process.env.DISPLAY!,
            XAUTHORITY: process.env.XAUTHORITY!,
          },
        },
        (error) => (error ? reject(new Error("Owned annotation selection failed")) : resolve()),
      ),
    );
    await editor;
    await os(A.owner, ["Return"]);
    const result = await captured.promise;
    A.wc.ipc.removeListener("preview:element-picked", onPicked);
    // A failed overlap observation remains FAIL; no retry, shim or capture-method replacement.
    if (host.isPrivateEntry(A.wc)) {
      await A.wc.loadURL(`${primary}/login`);
      await focus(A);
      await freshClear(A);
    }
    return result;
  });
  await check("agentOwnedPreEntry", async () => {
    const guest = await makeGuest("fixture-agent-owned", "A", true, "actual-fixture-agent");
    activeGuest = guest;
    await focus(guest);
    const current = await target(guest);
    if ((await service.linked(current)).length !== 1) return false;
    const before = receipt.counts.credentialReads;
    const refused = await rejected(service.fill(current, reference));
    return (
      guest.control.agentId === "actual-fixture-agent" &&
      refused &&
      refusals.get(guest.id) === "agent-owned" &&
      receipt.counts.credentialReads === before &&
      !host.isPrivateEntry(guest.wc) &&
      (await observer(guest, true)) === true
    );
  });
  await check("viewerOwnedPreEntry", async () => {
    const guest = await makeGuest("fixture-viewer-owned", "A");
    await guest.control.take("other-human-viewer");
    activeGuest = guest;
    await focus(guest);
    const current = await target(guest);
    if ((await service.linked(current)).length !== 1) return false;
    const before = receipt.counts.credentialReads;
    const refused = await rejected(service.fill(current, reference));
    return (
      guest.control.controller === "other-human-viewer" &&
      refused &&
      refusals.get(guest.id) === "viewer-owned" &&
      receipt.counts.credentialReads === before &&
      !host.isPrivateEntry(guest.wc)
    );
  });
  await check("unsupportedAuthority", async () => {
    const guest = await makeGuest("fixture-headless", "A");
    const tab = nativeTabs.get(guest.id)!;
    tab.desktop = null;
    activeGuest = guest;
    await focus(guest);
    const current = await target(guest);
    if ((await service.linked(current)).length !== 1) return false;
    const before = receipt.counts.credentialReads;
    const refused = await rejected(service.fill(current, reference));
    return (
      refused &&
      refusals.get(guest.id) === "unavailable" &&
      receipt.counts.credentialReads === before &&
      !host.isPrivateEntry(guest.wc)
    );
  });
  activeGuest = A;
  await focus(A);
  await check("unlink", async () => {
    await focus(A);
    const current = await target(A);
    const previous = await store.read();
    await store.write([
      ...previous,
      { ...reference, origin: secondary, partition: current.partition },
      { ...reference, origin: primary, partition: "persist:other-owned-fixture" },
    ]);
    const before = receipt.counts.credentialReads;
    await nativeChoice(A, await makeAutofillMenu(current, service, menuUi(A)), [
      "Down",
      "Right",
      "Down",
      "Return",
    ]);
    const menu = await makeAutofillMenu(current, service, menuUi(A));
    const submenu = menu[0]?.submenu;
    return (
      (await store.read()).length === previous.length + 1 &&
      (await service.linked(current)).length === 0 &&
      Array.isArray(submenu) &&
      !submenu.some((item) => item.label?.startsWith("Fill ")) &&
      receipt.counts.credentialReads === before
    );
  });
}

async function main() {
  await check(
    "runtime",
    async () =>
      receipt.runtime.electron === "44.4.5" &&
      receipt.runtime.executable === binding.executable &&
      receipt.runtime.sha256 === binding.executableSha256 &&
      hash(NodeFS.readFileSync(process.argv[1]!)) === binding.entrySha256 &&
      hash(NodeFS.readFileSync(NodePath.join(repo, "pnpm-lock.yaml"))) === binding.lockSha256 &&
      process.env.GITHUB_SHA === binding.source &&
      process.env.GITHUB_RUN_ID === binding.runId,
  );
  if (checks.runtime !== "PASS") throw new Error("Runtime identity");
  if (!NodeFS.existsSync(preload)) throw new Error("Production preload not built");
  await app.whenReady();
  primary = await serve();
  secondary = await serve();
  await constrain(session.defaultSession);
  const base = Layer.mergeAll(
    NodeFileSystem.layer,
    EffectNodeCrypto.layer,
    Path.layer,
    Layer.succeed(HostProcess.Platform, "linux"),
    // Only the environment fields read by Manager are supplied; no production state is loaded.
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      dirname: NodePath.dirname(preload),
      browserArtifactsDir: NodePath.join(temporary, "artifacts"),
      path: { join: NodePath.join },
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
      register: () => Effect.void,
      recordMetrics: () => Effect.void,
      shutdown: Effect.void,
    }),
    Layer.succeed(PreviewPasskeys.PreviewPasskeys, {
      bridgeEnabled: false,
      configure: Effect.void,
      installSessionHandlers: () => {},
      attachGuest: () => () => {},
    }),
  );
  const dependencies = Layer.mergeAll(
    DesktopBrowserHost.layer,
    BrowserSession.layer.pipe(Layer.provide(ElectronDialog.layer)),
  ).pipe(Layer.provideMerge(base));
  const program = Effect.gen(function* () {
    const manager = yield* PreviewManager.make;
    const host = yield* DesktopBrowserHost.DesktopBrowserHost;
    const profiles = yield* BrowserSession.BrowserSession;
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const replies = new Map<number, { privateEntry: boolean; success: boolean }>();
    const cdpEvents = { count: 0 };
    const connection = host.createConnection();
    const nativeTabs = new Map<
      string,
      { control: SessionControl; desktop: object | null; closing: boolean }
    >();
    const refusals = new Map<string, string>();
    const router = yield* DesktopChannel.makePrivateEntryRouter((response) =>
      Effect.gen(function* () {
        if (response.type === "private-entry-refused")
          refusals.set(response.tabId, response.reason);
        yield* connection.handleCommandLine(JSON.stringify(response));
        return true;
      }),
    );
    const authority = yield* ServerBrowser.makeDesktopPrivateEntryAuthority(router, (key) =>
      key.threadId === "fixture-thread" ? nativeTabs.get(key.tabId) : undefined,
    );
    yield* Effect.addFinalizer(() => connection.closed.pipe(Effect.andThen(router.close)));
    yield* connection.events.pipe(
      Stream.runForEach((bytes) =>
        Effect.gen(function* () {
          const item = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent))(
            new TextDecoder().decode(bytes),
          );
          if (item.type === "attached") {
            yield* router.attach(item, item.privateEntry);
            events.get(`authority-attached-${item.tabId}`)?.resolve();
            return;
          }
          if (item.type === "detached") {
            yield* router.detach(item, item.privateEntry);
            return;
          }
          if (
            item.type === "private-entry-acquire" ||
            item.type === "private-entry-release" ||
            item.type === "private-entry-cancel"
          ) {
            yield* router.receive(item);
            return;
          }
          if (
            !item ||
            typeof item !== "object" ||
            !("type" in item) ||
            item.type !== "cdp" ||
            !("message" in item) ||
            typeof item.message !== "string"
          )
            return;
          const packet = JSON.parse(item.message) as {
            id?: number;
            error?: { code?: number; message?: string };
            result?: unknown;
            method?: string;
            params?: { args?: { value?: unknown }[] };
          };
          if (typeof packet.id === "number") {
            replies.set(packet.id, {
              privateEntry:
                packet.error?.code === -32000 &&
                packet.error.message === "This tab is private during credential entry.",
              success: packet.error === undefined && "result" in packet,
            });
            events.get(`reply-${packet.id}`)?.resolve();
          } else {
            cdpEvents.count += 1;
            if (
              packet.method === "Runtime.consoleAPICalled" &&
              packet.params?.args?.some((argument) => argument.value === "owned-public-baseline")
            )
              events.get("public-console")?.resolve();
          }
        }),
      ),
      Effect.ensuring(router.close),
      Effect.forkScoped,
    );
    yield* Effect.promise(() =>
      exercise(
        manager,
        host,
        profiles,
        run,
        replies,
        cdpEvents,
        connection,
        nativeTabs,
        authority.controlChanged,
        refusals,
      ),
    );
  }).pipe(Effect.provide(dependencies), Effect.scoped);
  await Effect.runPromise(program);
  await finish(false);
}
void main().catch(() => finish(true, "main-rejected"));
