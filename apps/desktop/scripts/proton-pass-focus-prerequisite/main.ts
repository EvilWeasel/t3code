/** Credential-free focus prerequisite. No autofill, provider, menu or server authority is exercised. */
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Http from "node:http";
import * as Crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import { app, BrowserWindow, session, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as EffectPath from "effect/Path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Manager from "../../src/preview/Manager.ts";
import * as BrowserSession from "../../src/preview/BrowserSession.ts";
import * as BrowserHost from "../../src/preview/DesktopBrowserHost.ts";
import * as Environment from "../../src/app/DesktopEnvironment.ts";
import * as History from "../../src/telemetry/DesktopRendererHistory.ts";
import * as Dialog from "../../src/electron/ElectronDialog.ts";
import * as Passkeys from "../../src/preview/Passkeys.ts";

const hash = (value: NodeJS.ArrayBufferView | string) =>
  Crypto.createHash("sha256").update(value).digest("hex");
type Scenario = "single-focus" | "second-focus-before-close";
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  const value = process.argv[i + 1];
  if (
    !name ||
    !value ||
    !["--output", "--temporary", "--binding", "--repo", "--scenario"].includes(name) ||
    args.has(name) ||
    (name === "--scenario"
      ? !["single-focus", "second-focus-before-close"].includes(value)
      : !Path.isAbsolute(value))
  )
    throw new Error("Invalid focus child arguments");
  args.set(name, value);
}
if (
  args.size !== 5 ||
  process.platform !== "linux" ||
  process.getuid?.() === 0 ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.MORROWBYTE_FOCUS_PREREQUISITE !== "1" ||
  process.env.MORROWBYTE_RUNNER_PROFILE !== "blacksmith-8vcpu-ubuntu-2404"
)
  throw new Error("Focus job required");
const scenario = args.get("--scenario")! as Scenario;
const output = args.get("--output")!;
const temporary = args.get("--temporary")!;
const repo = args.get("--repo")!;
if (FS.readFileSync(Path.join(temporary, ".owned"), "utf8") !== "synthetic-focus-only")
  throw new Error("Unowned focus temp");
const binding = JSON.parse(FS.readFileSync(args.get("--binding")!, "utf8")) as {
  source: string;
  lockSha256: string;
  runId: string;
  executable: string;
  executableSha256: string;
  entrySha256: string;
  assertedRunnerProfile: string;
  runnerAttestation: string;
  privateDisplayBound: boolean;
  scenario: Scenario;
};
type Stage =
  | "startup"
  | "runtime"
  | "app-ready"
  | "guest-load"
  | "guest-register"
  | "inline-readiness"
  | "ready-transport"
  | "blur"
  | "observer-arm"
  | "baseline"
  | "electron-focus"
  | "os-focus"
  | "os-close"
  | "field-focus"
  | "dom-observation"
  | "focus-transport"
  | "server-focus"
  | "identity"
  | "negative-second-focus"
  | "final-observation"
  | "complete";
type Failure =
  | "runtime"
  | "guest"
  | "inline-listener-readiness"
  | "ready-transport"
  | "observer-readiness"
  | "baseline"
  | "os-spawn"
  | "os-command"
  | "electron-focus"
  | "dom-event"
  | "inline-event"
  | "focus-transport"
  | "loopback-focus"
  | "identity"
  | "watchdog"
  | "uncaught"
  | "unhandled"
  | "main-rejected"
  | "receipt-write";
type Check =
  | "runtime"
  | "guest"
  | "inlineListener"
  | "readyTransport"
  | "observer"
  | "baseline"
  | "os"
  | "electronFocus"
  | "domEvent"
  | "inlineEvent"
  | "focusTransport"
  | "loopbackFocus"
  | "identity";
const required: readonly Check[] = [
  "runtime",
  "guest",
  "inlineListener",
  "readyTransport",
  "observer",
  "baseline",
  "os",
  "electronFocus",
  "domEvent",
  "inlineEvent",
  "focusTransport",
  "loopbackFocus",
  "identity",
];
const checks = Object.fromEntries(required.map((key) => [key, "UNKNOWN_REQUIRED"])) as Record<
  Check,
  "UNKNOWN_REQUIRED" | "PASS" | "FAIL"
>;
const receipt = {
  scope: "FOCUS_PREREQUISITE_ONLY",
  autofill: "NOT_EXERCISED",
  scenario,
  binding,
  observation: {
    cutoff: "WORLD1005_CLOSE_TASK",
    afterCutoff: "FUTURE_EVENTS_NOT_CLAIMED",
    inlineClosed: false,
    domClosed: false,
    closed: false,
    validationComplete: false,
  },
  negative: { secondFocusIssued: false, secondFocusCompleted: false, qualified: false },
  runtime: {
    electron: process.versions.electron ?? "",
    executable: FS.realpathSync(process.execPath),
    sha256: hash(FS.readFileSync(process.execPath)),
  },
  checks,
  stage: "startup" as Stage,
  firstFailure: null as Failure | null,
  failureStage: null as Stage | null,
  ids: {
    window: null as number | null,
    webContents: null as number | null,
    mainFrame: null as number | null,
  },
  identity: {
    sameWindow: false,
    sameWebContents: false,
    sameMainFrame: false,
    documentUnchanged: false,
    ownerFocused: false,
    guestFocused: false,
  },
  inline: {
    scriptRan: false,
    listenerReady: false,
    closed: false,
    fieldPresent: false,
    readyAttempted: false,
    readyAck: false,
    readyFailed: false,
    focusCount: 0,
    eventExact: false,
    focusAttempted: false,
    focusAck: false,
    focusFailed: false,
  },
  dom: {
    ready: false,
    closed: false,
    documentSame: false,
    fieldSame: false,
    connected: false,
    empty: false,
    active: false,
    count: 0,
    eventExact: false,
  },
  baseline: { inactive: false, inlineCount: 0, domCount: 0 },
  beforeField: { domCount: 0, inlineCount: 0 },
  loopback: { readyCount: 0, focusCount: 0, correlationRejected: 0 },
  os: {
    pid: null as number | null,
    operation: "windowfocus",
    completed: false,
    succeeded: false,
    exited: false,
    closed: false,
    exitCode: null as number | null,
    signal: null as "SIGTERM" | "SIGKILL" | "other" | null,
    timedOut: null as boolean | null,
  },
  productionPreloadSha256: null as string | null,
  readiness: {
    ownerLoaded: false,
    guestAttached: false,
    guestLoaded: false,
    mainFrameOriginMatches: false,
    guestTypeMatches: false,
  },
  blockedNetwork: 0,
  diagnosticsWriteFailed: false,
  cleanup: "not-started",
  phase: "partial",
  passed: false,
};
let frozen = false;
let finishing = false;
let window: BrowserWindow | undefined;
let server: Http.Server | undefined;
const osChildren = new Map<ChildProcess.ChildProcess, Promise<void>>();
const deferred = <T>() => Promise.withResolvers<T>();
// Persistent milestones exist before serving or loading the page. Early requests are never dropped.
const readyReceived = deferred<void>();
const focusReceived = deferred<void>();
function rawWrite(partial: boolean) {
  if (partial && frozen) return;
  const target = Path.join(
    output,
    partial ? "fixture-receipt.partial.json" : "fixture-receipt.json",
  );
  const pending = `${target}.tmp`;
  try {
    const fd = FS.openSync(pending, "w", 0o600);
    try {
      FS.writeFileSync(fd, JSON.stringify(receipt, null, 2));
      FS.fsyncSync(fd);
    } finally {
      FS.closeSync(fd);
    }
    FS.renameSync(pending, target);
    const directory = FS.openSync(output, "r");
    try {
      FS.fsyncSync(directory);
    } finally {
      FS.closeSync(directory);
    }
  } finally {
    if (FS.existsSync(pending)) FS.unlinkSync(pending);
  }
}
function latch(reason: Failure, persist = true) {
  if (receipt.firstFailure !== null) return;
  receipt.firstFailure = reason;
  receipt.failureStage = receipt.stage;
  receipt.passed = false;
  if (persist) write(true, false);
  frozen = true;
}
function write(partial: boolean, startFinish = true): boolean {
  try {
    rawWrite(partial);
    return true;
  } catch {
    receipt.diagnosticsWriteFailed = true;
    receipt.passed = false;
    latch("receipt-write", false);
    if (startFinish) void finish();
    return false;
  }
}
function running() {
  if (receipt.firstFailure !== null || finishing) throw new Error("Focus prerequisite stopped");
}
function stage(value: Stage) {
  running();
  receipt.stage = value;
  write(true);
  running();
}
function stop(reason: Failure): never {
  latch(reason);
  void finish();
  throw new Error("Focus prerequisite failed");
}
function requireCheck(key: Check, valid: boolean, reason: Failure) {
  running();
  checks[key] = valid ? "PASS" : "FAIL";
  write(true);
  running();
  if (!valid) stop(reason);
}
app.on("window-all-closed", () => {});
app.setPath("userData", Path.join(temporary, "user-data"));
app.setPath("sessionData", Path.join(temporary, "session-data"));
async function finish() {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  receipt.cleanup = "pending";
  write(true, false);
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupExpired = false;
  try {
    await Promise.race([
      (async () => {
        const children = [...osChildren.entries()];
        for (const [child] of children) child.kill("SIGKILL");
        if (window && !window.isDestroyed()) window.destroy();
        await Promise.all([
          ...children.map(([, closed]) => closed),
          new Promise<void>((resolve) => {
            if (!server) return resolve();
            server.closeAllConnections();
            server.close(() => resolve());
          }),
        ]);
        if (!cleanupExpired) receipt.cleanup = "complete";
      })(),
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(() => {
          cleanupExpired = true;
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
    receipt.firstFailure === null &&
    !receipt.diagnosticsWriteFailed &&
    receipt.cleanup === "complete" &&
    receipt.blockedNetwork === 0 &&
    scenario === "single-focus" &&
    receipt.observation.closed &&
    receipt.observation.validationComplete &&
    required.every((key) => checks[key] === "PASS");
  const unaffected: readonly Check[] = [
    "runtime",
    "guest",
    "inlineListener",
    "readyTransport",
    "observer",
    "baseline",
    "os",
    "electronFocus",
    "focusTransport",
    "identity",
  ];
  receipt.negative.qualified =
    scenario === "second-focus-before-close" &&
    receipt.firstFailure === "dom-event" &&
    receipt.negative.secondFocusIssued &&
    receipt.negative.secondFocusCompleted &&
    receipt.observation.closed &&
    receipt.observation.validationComplete &&
    receipt.dom.closed &&
    receipt.inline.closed &&
    receipt.dom.count === 2 &&
    receipt.inline.focusCount === 2 &&
    receipt.dom.eventExact &&
    receipt.inline.eventExact &&
    receipt.loopback.readyCount === 1 &&
    receipt.loopback.focusCount === 2 &&
    receipt.loopback.correlationRejected === 0 &&
    checks.domEvent === "FAIL" &&
    checks.inlineEvent === "FAIL" &&
    checks.loopbackFocus === "FAIL" &&
    unaffected.every((key) => checks[key] === "PASS") &&
    !receipt.diagnosticsWriteFailed &&
    receipt.blockedNetwork === 0 &&
    receipt.cleanup === "complete";
  if (!write(false, false)) write(false, false);
  app.exit(receipt.passed ? 0 : 1);
}
const watchdog = setTimeout(() => {
  latch("watchdog");
  void finish();
}, 120000);
process.on("uncaughtException", () => {
  latch("uncaught");
  void finish();
});
process.on("unhandledRejection", () => {
  latch("unhandled");
  void finish();
});

let origin = "";
const instance = Crypto.randomBytes(16).toString("hex");
let partition = "";
const loginHtml =
  () => `<!doctype html><meta charset="utf-8"><input id="focus-target" type="text" autocomplete="off"><script nonce="fixture">
(() => {
 const field=document.getElementById('focus-target');
 const s=globalThis.__focusPrerequisite={scriptRan:true,listenerReady:false,closed:false,readyAttempted:false,readyAck:false,readyFailed:false,focusCount:0,eventExact:false,focusAttempted:false,focusAck:false,focusFailed:false};
 const send=name=>fetch('/'+name+'?instance=${instance}',{method:'POST'}).then(r=>r.status===204).catch(()=>false);
 field.addEventListener('focus',event=>{
  if(s.closed)return;
  s.focusCount=Math.min(3,s.focusCount+1);s.eventExact=event.target===field&&event.currentTarget===field&&field.ownerDocument===document;
  s.focusAttempted=true;s.focusAck=false;s.focusFailed=false;s.focusPromise=send('focused').then(ok=>{s.focusAck=ok;s.focusFailed=!ok;return ok});
 });
 s.listenerReady=true;s.readyAttempted=true;
 s.readyPromise=send('ready').then(ok=>{s.readyAck=ok;s.readyFailed=!ok;return ok});
})();</script>`;
async function serve() {
  server = Http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/ready" || url.pathname === "/focused") {
      const correlated =
        request.method === "POST" &&
        url.searchParams.get("instance") === instance &&
        request.headers.origin === origin;
      if (!correlated) {
        receipt.loopback.correlationRejected = Math.min(
          2,
          receipt.loopback.correlationRejected + 1,
        );
        checks.loopbackFocus = "FAIL";
        if (receipt.observation.validationComplete) {
          latch("loopback-focus");
          void finish();
        }
        response.writeHead(400);
        response.end();
        return;
      }
      if (url.pathname === "/ready") {
        receipt.loopback.readyCount = Math.min(3, receipt.loopback.readyCount + 1);
        readyReceived.resolve();
      } else {
        receipt.loopback.focusCount = Math.min(3, receipt.loopback.focusCount + 1);
        focusReceived.resolve();
      }
      if (receipt.loopback.readyCount > 1) checks.readyTransport = "FAIL";
      if (receipt.loopback.focusCount > 1) checks.loopbackFocus = "FAIL";
      write(true);
      response.writeHead(204);
      response.end();
      if (
        receipt.observation.validationComplete &&
        (receipt.loopback.readyCount > 1 || receipt.loopback.focusCount > 1)
      ) {
        latch(receipt.loopback.readyCount > 1 ? "ready-transport" : "loopback-focus");
        void finish();
      }
      return;
    }
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-fixture'; style-src 'nonce-fixture'; frame-src ${origin}; connect-src ${origin}; img-src ${origin}`,
    );
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname === "/login") response.end(loginHtml());
    else if (url.pathname === "/host")
      response.end(
        `<!doctype html><style nonce="fixture">html,body,webview{width:100%;height:100%;margin:0;display:flex}</style><webview partition="${partition}" src="${origin}/login" preload="file://${preload}"></webview>`,
      );
    else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") stop("guest");
  origin = `http://127.0.0.1:${address.port}`;
}
const secured = new WeakSet<Electron.Session>();
async function constrain(target: Electron.Session) {
  if (secured.has(target)) return;
  secured.add(target);
  await target.setProxy({ mode: "direct" });
  running();
  target.webRequest.onBeforeRequest((details, callback) => {
    let allowed = details.url === "about:blank";
    try {
      allowed ||= new URL(details.url).origin === origin;
    } catch {
      /* No URL output. */
    }
    if (!allowed) receipt.blockedNetwork = Math.min(2, receipt.blockedNetwork + 1);
    callback({ cancel: !allowed });
  });
}
const preload = Path.join(repo, "apps/desktop/dist-electron/preview-pick-preload.cjs");
async function focusOs(owner: BrowserWindow) {
  stage("os-focus");
  const handle = owner.getNativeWindowHandle();
  const xid = handle.length >= 8 ? Number(handle.readBigUInt64LE()) : handle.readUInt32LE();
  if (!Number.isSafeInteger(xid) || xid <= 0 || owner.isDestroyed()) stop("identity");
  const closed = deferred<void>();
  await new Promise<void>((resolve, reject) => {
    running();
    let child: ChildProcess.ChildProcess;
    let spawned = false;
    try {
      child = ChildProcess.execFile(
        "/usr/bin/xdotool",
        ["windowfocus", "--sync", String(xid)],
        {
          timeout: 5000,
          env: {
            PATH: "/usr/bin:/bin",
            DISPLAY: process.env.DISPLAY!,
            XAUTHORITY: process.env.XAUTHORITY!,
          },
        },
        (error) => {
          receipt.os.completed = true;
          receipt.os.succeeded = error === null;
          write(true);
          if (error || receipt.firstFailure !== null || finishing) {
            if (error) latch("os-command");
            void finish();
            reject(new Error("Owned focus command failed"));
          } else resolve();
        },
      );
    } catch {
      latch("os-spawn");
      void finish();
      reject(new Error("Owned focus spawn failed"));
      return;
    }
    osChildren.set(child, closed.promise);
    child.once("spawn", () => {
      spawned = true;
      receipt.os.pid = child.pid ?? null;
      if (finishing || receipt.firstFailure !== null) child.kill("SIGKILL");
      else write(true);
    });
    child.once("error", () => {
      latch(spawned ? "os-command" : "os-spawn");
      void finish();
    });
    const ended = (code: number | null, signal: NodeJS.Signals | null) => {
      receipt.os.exitCode = code;
      receipt.os.signal =
        signal === null ? null : signal === "SIGTERM" || signal === "SIGKILL" ? signal : "other";
    };
    child.once("exit", (code, signal) => {
      receipt.os.exited = true;
      ended(code, signal);
      write(true);
    });
    child.once("close", (code, signal) => {
      receipt.os.closed = true;
      ended(code, signal);
      osChildren.delete(child);
      closed.resolve();
      write(true);
    });
  });
  stage("os-close");
  await closed.promise;
  running();
  requireCheck(
    "os",
    receipt.os.completed &&
      receipt.os.succeeded &&
      receipt.os.exited &&
      receipt.os.closed &&
      receipt.os.exitCode === 0,
    "os-command",
  );
}
const inlineCodec = Schema.Struct({
  scriptRan: Schema.Boolean,
  listenerReady: Schema.Boolean,
  closed: Schema.Boolean,
  fieldPresent: Schema.Boolean,
  readyAttempted: Schema.Boolean,
  readyAck: Schema.Boolean,
  readyFailed: Schema.Boolean,
  focusCount: Schema.Number,
  eventExact: Schema.Boolean,
  focusAttempted: Schema.Boolean,
  focusAck: Schema.Boolean,
  focusFailed: Schema.Boolean,
});
const domCodec = Schema.Struct({
  ready: Schema.Boolean,
  closed: Schema.Boolean,
  documentSame: Schema.Boolean,
  fieldSame: Schema.Boolean,
  connected: Schema.Boolean,
  empty: Schema.Boolean,
  active: Schema.Boolean,
  count: Schema.Number,
  eventExact: Schema.Boolean,
});
const decodeInline = Schema.decodeUnknownSync(inlineCodec);
const decodeDom = Schema.decodeUnknownSync(domCodec);
const inlineScript = (
  close = false,
) => `(() => {const s=globalThis.__focusPrerequisite;if(s&&${close})s.closed=true;return {closed:s?.closed===true,
 scriptRan:s?.scriptRan===true,listenerReady:s?.listenerReady===true,fieldPresent:document.getElementById('focus-target') instanceof HTMLInputElement,
 readyAttempted:s?.readyAttempted===true,readyAck:s?.readyAck===true,readyFailed:s?.readyFailed===true,
 focusCount:Number.isInteger(s?.focusCount)?Math.min(3,s.focusCount):0,eventExact:s?.eventExact===true,
 focusAttempted:s?.focusAttempted===true,focusAck:s?.focusAck===true,focusFailed:s?.focusFailed===true};})()`;
const armObserver = `(() => {const field=document.getElementById('focus-target');if(globalThis.__focusObserver || !(field instanceof HTMLInputElement))return false;
 const s=globalThis.__focusObserver={document,field,count:0,eventExact:false,closed:false};
 field.addEventListener('focus',e=>{if(s.closed)return;s.count=Math.min(3,s.count+1);s.eventExact=e.target===s.field&&e.currentTarget===s.field&&s.field.ownerDocument===s.document;},true);return true;})()`;
const domScript = (
  close = false,
) => `(() => {const s=globalThis.__focusObserver;if(s&&${close})s.closed=true;return {ready:!!s,closed:s?.closed===true,documentSame:s?.document===document,
 fieldSame:s?.field===document.getElementById('focus-target'),connected:s?.field?.isConnected===true,
 empty:s?.field?.value==='',active:!!s&&document.activeElement===s.field,count:Number.isInteger(s?.count)?Math.min(3,s.count):0,eventExact:s?.eventExact===true};})()`;

async function exercise(
  manager: Manager.PreviewManager["Service"],
  profiles: BrowserSession.BrowserSession["Service"],
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
) {
  partition = await run(profiles.getPartition("focus-prerequisite", true, "profile"));
  running();
  await constrain(await run(profiles.getSession("focus-prerequisite", true, "profile")));
  running();
  const owner = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window = owner;
  receipt.ids.window = owner.id;
  await run(manager.setMainWindow(owner));
  running();
  const attached = deferred<WebContents>();
  const loaded = deferred<void>();
  owner.webContents.once("did-attach-webview", (_event, guest) => {
    receipt.readiness.guestAttached = true;
    // Register in the native attach callback, before returning the captured guest to any awaiter.
    guest.once("did-finish-load", () => {
      receipt.readiness.guestLoaded = true;
      write(true);
      loaded.resolve();
    });
    guest.once("did-fail-load", () => {
      latch("guest");
      void finish();
    });
    write(true);
    attached.resolve(guest);
  });
  stage("guest-load");
  const loading = owner.loadURL(`${origin}/host`);
  const wc = await attached.promise;
  running();
  await loading;
  running();
  receipt.readiness.ownerLoaded = true;
  write(true);
  await loaded.promise;
  running();
  stage("guest-register");
  await run(manager.createTab("focus-prerequisite"));
  running();
  await run(manager.registerWebview("focus-prerequisite", wc.id));
  running();
  const frame = wc.mainFrame;
  receipt.readiness.mainFrameOriginMatches =
    frame.origin === origin && wc.getURL() === `${origin}/login`;
  receipt.readiness.guestTypeMatches = wc.getType() === "webview" && wc !== owner.webContents;
  receipt.ids.webContents = wc.id;
  receipt.ids.mainFrame = frame.routingId;
  let navigated = false;
  wc.on("did-start-navigation", () => {
    navigated = true;
    receipt.identity.documentUnchanged = false;
    write(true);
  });
  const identity = () => {
    running();
    Object.assign(receipt.identity, {
      sameWindow: !owner.isDestroyed() && owner.id === receipt.ids.window,
      sameWebContents: !wc.isDestroyed() && wc.id === receipt.ids.webContents,
      sameMainFrame: !wc.isDestroyed() && !frame.isDestroyed() && wc.mainFrame === frame,
      documentUnchanged: !navigated,
      ownerFocused: !owner.isDestroyed() && owner.isFocused(),
      guestFocused: !wc.isDestroyed() && wc.isFocused(),
    });
    if (
      !receipt.identity.sameWindow ||
      !receipt.identity.sameWebContents ||
      !receipt.identity.sameMainFrame ||
      navigated
    )
      stop("identity");
  };
  const inline = async (close = false) => {
    identity();
    const raw: unknown = await wc.executeJavaScript(inlineScript(close));
    identity();
    try {
      const value = decodeInline(raw);
      if (!Number.isInteger(value.focusCount) || value.focusCount < 0 || value.focusCount > 3)
        stop("inline-listener-readiness");
      Object.assign(receipt.inline, value);
    } catch {
      stop("inline-listener-readiness");
    }
    write(true);
    running();
  };
  const dom = async (close = false) => {
    identity();
    const raw: unknown = await wc.executeJavaScriptInIsolatedWorld(1005, [
      { code: domScript(close) },
    ]);
    identity();
    try {
      const value = decodeDom(raw);
      if (!Number.isInteger(value.count) || value.count < 0 || value.count > 3)
        stop("observer-readiness");
      Object.assign(receipt.dom, value);
    } catch {
      stop("observer-readiness");
    }
    write(true);
    running();
  };
  requireCheck(
    "guest",
    wc.session === (await run(profiles.getSession("focus-prerequisite", true, "profile"))) &&
      receipt.readiness.guestAttached &&
      receipt.readiness.guestLoaded &&
      receipt.readiness.ownerLoaded &&
      receipt.readiness.mainFrameOriginMatches &&
      receipt.readiness.guestTypeMatches,
    "guest",
  );
  stage("inline-readiness");
  await inline();
  running();
  requireCheck(
    "inlineListener",
    receipt.inline.scriptRan &&
      receipt.inline.listenerReady &&
      receipt.inline.fieldPresent &&
      receipt.inline.readyAttempted,
    "inline-listener-readiness",
  );
  stage("ready-transport");
  const readyAck: unknown = await wc.executeJavaScript(
    "globalThis.__focusPrerequisite.readyPromise",
  );
  identity();
  await inline();
  running();
  requireCheck(
    "readyTransport",
    readyAck === true &&
      receipt.inline.readyAck &&
      !receipt.inline.readyFailed &&
      receipt.loopback.readyCount === 1,
    "ready-transport",
  );
  await readyReceived.promise;
  identity();
  stage("blur");
  await wc.executeJavaScript("document.activeElement?.blur()");
  identity();
  stage("observer-arm");
  const armed: unknown = await wc.executeJavaScriptInIsolatedWorld(1005, [{ code: armObserver }]);
  identity();
  requireCheck("observer", armed === true, "observer-readiness");
  stage("baseline");
  await dom();
  await inline();
  running();
  receipt.baseline = {
    inactive: !receipt.dom.active,
    inlineCount: receipt.inline.focusCount,
    domCount: receipt.dom.count,
  };
  requireCheck(
    "baseline",
    receipt.dom.ready &&
      receipt.dom.documentSame &&
      receipt.dom.fieldSame &&
      receipt.dom.connected &&
      receipt.dom.empty &&
      !receipt.dom.active &&
      receipt.dom.count === 0 &&
      receipt.inline.focusCount === 0,
    "baseline",
  );
  stage("electron-focus");
  owner.focus();
  running();
  wc.focus();
  running();
  await focusOs(owner);
  identity();
  requireCheck(
    "electronFocus",
    receipt.identity.ownerFocused && receipt.identity.guestFocused,
    "electron-focus",
  );
  await dom();
  await inline();
  running();
  receipt.beforeField = { domCount: receipt.dom.count, inlineCount: receipt.inline.focusCount };
  stage("field-focus");
  const active: unknown = await wc.executeJavaScript(
    "(()=>{const f=document.getElementById('focus-target');f.focus();return document.activeElement===f})()",
  );
  identity();
  stage("dom-observation");
  await dom();
  await inline();
  running();
  requireCheck(
    "domEvent",
    active === true &&
      receipt.dom.ready &&
      receipt.dom.active &&
      receipt.dom.count === 1 &&
      receipt.dom.eventExact,
    "dom-event",
  );
  requireCheck(
    "inlineEvent",
    receipt.inline.focusCount === 1 && receipt.inline.eventExact && receipt.inline.focusAttempted,
    "inline-event",
  );
  stage("focus-transport");
  const focusAck: unknown = await wc.executeJavaScript(
    "globalThis.__focusPrerequisite.focusPromise",
  );
  identity();
  await inline();
  running();
  requireCheck(
    "focusTransport",
    focusAck === true && receipt.inline.focusAck && !receipt.inline.focusFailed,
    "focus-transport",
  );
  stage("server-focus");
  requireCheck(
    "loopbackFocus",
    receipt.loopback.focusCount === 1 && receipt.loopback.correlationRejected === 0,
    "loopback-focus",
  );
  await focusReceived.promise;
  identity();
  if (scenario === "second-focus-before-close") {
    stage("negative-second-focus");
    receipt.negative.secondFocusIssued = true;
    write(true);
    running();
    const second: unknown = await wc.executeJavaScript(
      "(()=>{const f=document.getElementById('focus-target');f.blur();f.focus();return document.activeElement===f})()",
    );
    identity();
    receipt.negative.secondFocusCompleted = second === true;
  }
  stage("final-observation");
  // Inline closes first; world1005 continues to witness events until its own close task.
  await inline(true);
  identity();
  receipt.observation.inlineClosed = receipt.inline.closed;
  await dom(true);
  identity();
  receipt.observation.domClosed = receipt.dom.closed;
  // The inline observer is closed, so this is its stable final fetch, not a moving Promise slot.
  const finalFocusAck: unknown = await wc.executeJavaScript(
    "globalThis.__focusPrerequisite.focusPromise",
  );
  identity();
  await inline();
  await dom();
  identity();
  receipt.observation.closed =
    receipt.observation.inlineClosed &&
    receipt.observation.domClosed &&
    receipt.inline.closed &&
    receipt.dom.closed;
  const finalChecks: readonly [Check, boolean, Failure][] = [
    [
      "inlineListener",
      receipt.inline.scriptRan &&
        receipt.inline.listenerReady &&
        receipt.inline.fieldPresent &&
        receipt.inline.closed,
      "inline-listener-readiness",
    ],
    [
      "readyTransport",
      readyAck === true &&
        receipt.inline.readyAck &&
        !receipt.inline.readyFailed &&
        receipt.loopback.readyCount === 1,
      "ready-transport",
    ],
    [
      "baseline",
      receipt.baseline.inactive &&
        receipt.baseline.domCount === 0 &&
        receipt.baseline.inlineCount === 0,
      "baseline",
    ],
    [
      "domEvent",
      receipt.observation.closed &&
        active === true &&
        receipt.dom.ready &&
        receipt.dom.count === 1 &&
        receipt.dom.eventExact,
      "dom-event",
    ],
    [
      "inlineEvent",
      receipt.inline.focusCount === 1 && receipt.inline.eventExact && receipt.inline.focusAttempted,
      "inline-event",
    ],
    [
      "focusTransport",
      finalFocusAck === true && receipt.inline.focusAck && !receipt.inline.focusFailed,
      "focus-transport",
    ],
    [
      "loopbackFocus",
      receipt.loopback.readyCount === 1 &&
        receipt.loopback.focusCount === 1 &&
        receipt.loopback.correlationRejected === 0,
      "loopback-focus",
    ],
    [
      "identity",
      receipt.dom.documentSame &&
        receipt.dom.fieldSame &&
        receipt.dom.connected &&
        receipt.dom.empty &&
        receipt.dom.active &&
        receipt.identity.ownerFocused &&
        receipt.identity.guestFocused,
      "identity",
    ],
  ];
  // Replace every affected flag before failing, so a late contradiction cannot leave stale PASSs.
  for (const [key, valid] of finalChecks) checks[key] = valid ? "PASS" : "FAIL";
  receipt.observation.validationComplete = true;
  write(true);
  running();
  const failed = finalChecks.find(([, valid]) => !valid);
  if (failed) stop(failed[2]);
  stage("complete");
}
async function main() {
  stage("runtime");
  requireCheck(
    "runtime",
    receipt.runtime.electron === "44.4.5" &&
      receipt.runtime.executable === binding.executable &&
      receipt.runtime.sha256 === binding.executableSha256 &&
      hash(FS.readFileSync(process.argv[1]!)) === binding.entrySha256 &&
      hash(FS.readFileSync(Path.join(repo, "pnpm-lock.yaml"))) === binding.lockSha256 &&
      process.env.GITHUB_SHA === binding.source &&
      process.env.GITHUB_RUN_ID === binding.runId &&
      binding.privateDisplayBound &&
      binding.scenario === scenario &&
      binding.assertedRunnerProfile === "blacksmith-8vcpu-ubuntu-2404",
    "runtime",
  );
  if (!FS.existsSync(preload)) stop("guest");
  receipt.productionPreloadSha256 = hash(FS.readFileSync(preload));
  stage("app-ready");
  await app.whenReady();
  running();
  await serve();
  running();
  await constrain(session.defaultSession);
  running();
  const base = Layer.mergeAll(
    NodeFileSystem.layer,
    NodeCrypto.layer,
    EffectPath.layer,
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(Environment.DesktopEnvironment, {
      dirname: Path.dirname(preload),
      browserArtifactsDir: Path.join(temporary, "artifacts"),
      path: { join: Path.join },
    } as Environment.DesktopEnvironment["Service"]),
    Layer.succeed(History.DesktopRendererHistory, {
      register: () => Effect.void,
      recordMetrics: () => Effect.void,
      shutdown: Effect.void,
    }),
    Layer.succeed(Passkeys.PreviewPasskeys, {
      bridgeEnabled: false,
      configure: Effect.void,
      installSessionHandlers: () => {},
      attachGuest: () => () => {},
    }),
  );
  const dependencies = Layer.mergeAll(
    BrowserHost.layer,
    BrowserSession.layer.pipe(Layer.provide(Dialog.layer)),
  ).pipe(Layer.provideMerge(base));
  await Effect.runPromise(
    Effect.gen(function* () {
      const manager = yield* Manager.make;
      const profiles = yield* BrowserSession.BrowserSession;
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      yield* Effect.promise(() => exercise(manager, profiles, run));
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );
  await finish();
}
void main().catch(() => {
  latch("main-rejected");
  void finish();
});
