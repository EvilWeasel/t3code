/** Real native CORE admission only. Never runs an installer or accesses user state. */
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Crypto from "node:crypto";
import * as Http from "node:http";
import { app, BrowserWindow, BaseWindow, session, webContents, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
import * as ElectronProtocol from "../../src/electron/ElectronProtocol.ts";
import * as ElectronApp from "../../src/electron/ElectronApp.ts";
import * as ElectronDialog from "../../src/electron/ElectronDialog.ts";
import * as ElectronMenu from "../../src/electron/ElectronMenu.ts";
import * as ElectronShell from "../../src/electron/ElectronShell.ts";
import * as ElectronTheme from "../../src/electron/ElectronTheme.ts";
import * as Environment from "../../src/app/DesktopEnvironment.ts";
import * as Config from "../../src/app/DesktopConfig.ts";
import * as Assets from "../../src/app/DesktopAssets.ts";
import * as Settings from "../../src/settings/DesktopAppSettings.ts";
import * as ClientSettings from "../../src/settings/DesktopClientSettings.ts";
import * as History from "../../src/telemetry/DesktopRendererHistory.ts";
import * as Manager from "../../src/preview/Manager.ts";
import * as BrowserSession from "../../src/preview/BrowserSession.ts";
import * as BrowserHost from "../../src/preview/DesktopBrowserHost.ts";
import * as Passkeys from "../../src/preview/Passkeys.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";
import {
  NixManagedUpdater,
  NixUpdateAdmissionError,
} from "../../src/electron/NixManagedUpdater.ts";
import { SnapShotFlash } from "../../src/snapShot/DesktopSnapShot.ts";

const nativePin = "9c66718304950879a203c11ce476237719e18831";
const nixPin = "abcc2efd064c436d417a70beeb1704d7796e9ebf";
const consumerPin = "661079b875bdc5ff1db66d6b0e9aa4b7a5bdb67a";
const pinnedSourceHashes = {
  "apps/desktop/src/electron/ElectronWindow.ts":
    "7bf806b3f80b87ea96ab784135a3ab8ca70f0bd20b8be6f60ff4806b8524311c",
  "apps/desktop/src/snapShot/DesktopSnapShot.ts":
    "b3bdfd29080ff5420d10a663fa52dbf085c02dfd44cb75f66926c53e0b083332",
  "apps/desktop/src/snapShot/SnapShotTransition.ts":
    "0f1a5a7c472297810a622d52f650221d888c14c8b9e608582fde1e6de5636b1a",
  "apps/desktop/src/electron/WindowsForegroundFocusThread.ts":
    "9c87bcc1accd4734330709c22d8f36bbab61736d8a9ae3d150defccafa24274d",
  "apps/desktop/src/snapShot/RegionSnapShot.ts":
    "72f15e88c628e510eae95e0cef0215232072f3491551983598b6eb4b0c60d6ee",
  "apps/desktop/src/snapShot/SnapShotAccessibilityProcess.ts":
    "f6da3fe29ab10adf193eabb8617c0ddf971502aa285bc34f5968cb862d62935d",
  "apps/desktop/src/electron/NixManagedUpdater.ts":
    "c9f1441f1ec02fc4985165b67e94474930a893637d65bf743a8bc7413bb34f48",
  "apps/desktop/src/permissions/MacPermissionHelper.ts":
    "6e1a1c647aae0287b816284f8d998106756af6ac72c66a273c1fa9d1a15349e1",
  "apps/desktop/src/preview/Manager.ts":
    "d77c79c869920e700c99932c84bd19a63605f82ad11cb291ad905cc7aeed8792",
  "apps/desktop/src/window/DesktopWindow.ts":
    "d075ea146024cb9fc9e76dbde176911317ddceb86ffa4c1cea1da64d77e17f29",
};
const sha = (bytes: NodeJS.ArrayBufferView | string) =>
  Crypto.createHash("sha256").update(bytes).digest("hex");
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  if (
    !key ||
    !value ||
    !["--output", "--temporary", "--binding", "--repo"].includes(key) ||
    flags.has(key) ||
    !Path.isAbsolute(value)
  )
    throw new Error("Invalid core child arguments");
  flags.set(key, value);
}
if (
  flags.size !== 4 ||
  process.platform !== "linux" ||
  process.getuid?.() === 0 ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.MORROWBYTE_CORE_UPDATE_ADMISSION !== "1" ||
  process.env.MORROWBYTE_RUNNER_PROFILE !== "blacksmith-8vcpu-ubuntu-2404"
)
  throw new Error("Core job required");
const output = flags.get("--output")!,
  temporary = flags.get("--temporary")!,
  repo = flags.get("--repo")!;
if (FS.readFileSync(Path.join(temporary, ".owned"), "utf8") !== "synthetic-core-update-admission")
  throw new Error("Unowned core state");
const binding = JSON.parse(FS.readFileSync(flags.get("--binding")!, "utf8")) as {
  scope: string;
  nativePin: string;
  nixPin: string;
  consumerPin: string;
  source: string;
  sourceHashes: Record<string, string>;
  runId: string;
  job: string;
  executable: string;
  executableSha256: string;
  entrySha256: string;
  preload: string;
  preloadSha256: string;
  pipPreloadSha256: string;
  privateDisplayBound: boolean;
  assertedRunnerProfile: string;
};
const required = [
  "runtime",
  "productionMain",
  "reservedNative",
  "pendingVeto",
  "unknownVeto",
  "releasedBindingRefused",
  "allocationRevokes",
  "oldTokenInvalid",
  "scopeReplacement",
  "heldGuest",
  "adversarialGuestBind",
  "guestUnknown",
  "guestPiP",
  "sameGuestRefusesInstall",
  "guestRetirement",
  "popupPositive",
  "popupUnknown",
  "popupRetirement",
  "activityVeto",
  "flashPositive",
  "heldFlash",
  "nixAccessRevocation",
  "nixActivationRevocation",
  "finalInventory",
] as const;
type Check = (typeof required)[number];
const checks = Object.fromEntries(required.map((name) => [name, "UNKNOWN_REQUIRED"])) as Record<
  Check,
  "UNKNOWN_REQUIRED" | "PASS" | "FAIL"
>;
const receipt = {
  scope: "CORE_UPDATE_ADMISSION_ONLY",
  actualInstaller: "NOT_EXERCISED",
  autofill: "NOT_EXERCISED",
  windows: "NOT_EXERCISED",
  macOS: "NOT_EXERCISED",
  nativePin,
  nixPin,
  consumerPin,
  binding,
  runtime: {
    electron: process.versions.electron ?? "",
    executable: FS.realpathSync(process.execPath),
    sha256: sha(FS.readFileSync(process.execPath)),
  },
  checks,
  stage: "startup" as string,
  firstFailure: null as string | null,
  failureStage: null as string | null,
  phase: "partial",
  passed: false,
  diagnosticsWriteFailed: false,
  cleanup: "not-started",
  classification: {
    heldPiPWithSameGuest: "NOT_REACHABLE_BY_CONTRACT",
    heldPopupWithSameGuest: "NOT_REACHABLE_BY_CONTRACT",
    heldPopupUnit: "SOURCE_ONLY_SEPARATE_CONSUMER_TEST",
    heldPiPUnit: "SOURCE_ONLY_SEPARATE_CONSUMER_TEST",
    nixAsync70: "ADAPTER_ONLY_SYNTHETIC_IO_REAL_NATIVE_REVOCATION",
    capture: "PRODUCTION_PIP_SYNTHETIC_LOOPBACK_ONLY_NO_SCREENSHOT_ARTIFACT",
    futureEvents: "NOT_CLAIMED_AFTER_OWNED_SHUTDOWN",
    popupRefusalCause: "GUEST_AND_POPUP_LIVE_NO_EXCLUSIVE_CAUSALITY",
  },
  reservationCoverage: {
    olderAllocationBindRefused: false,
    liveBoundReleaseRefused: false,
    destroyedBindingRestored: false,
  },
  finalInventory: {
    productionContentsIds: [] as number[],
    nativeWindowIds: [] as number[],
    nativeContentsIds: [] as number[],
    expectedWindowId: null as number | null,
    expectedContentsId: null as number | null,
    tokenValid: false,
    holdRetained: false,
  },
  observations: {
    allocations: 0,
    guestAllocations: 0,
    willAttach: 0,
    preventedAttach: 0,
    didAttach: 0,
    unknownAllocationRevokedSynchronously: false,
    preventedGuestAllocatedBeforeWill: false,
    popupRequests: 0,
    blockedNetwork: 0,
    signalRequests: 0,
  },
  ids: {
    main: null as number | null,
    mainContents: null as number | null,
    guest: null as number | null,
    popup: null as number | null,
    pip: null as number | null,
    flash: null as number | null,
  },
};
const executionAbort = new AbortController();
let frozen = false,
  finishing = false;
let server: Http.Server | undefined;
let effectsCleanup: (() => Promise<void>) | undefined;
const owned = new Set<Electron.BaseWindow>();
const contentsRetired = new Map<WebContents, Promise<void>>();
const lateDestructions = new Set<Promise<boolean>>();
let creationObserver: ((contents: WebContents) => void) | undefined;
let guestAllocation: ((contents: WebContents) => void) | undefined;
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function rawWrite(partial: boolean) {
  if (partial && frozen) return;
  const target = Path.join(
    output,
    partial ? "fixture-receipt.partial.json" : "fixture-receipt.json",
  );
  const pending = target + ".tmp";
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
function latch(reason: string) {
  if (receipt.firstFailure !== null) return;
  receipt.firstFailure = reason;
  receipt.failureStage = receipt.stage;
  receipt.passed = false;
  try {
    rawWrite(true);
  } catch {
    receipt.diagnosticsWriteFailed = true;
  }
  frozen = true;
  executionAbort.abort();
}
function write(partial = true) {
  try {
    rawWrite(partial);
  } catch {
    receipt.diagnosticsWriteFailed = true;
    latch("receipt-write");
    void finish();
  }
}
function running() {
  if (finishing || receipt.firstFailure !== null) throw new Error("Core stopped");
}
function requireValue(value: unknown) {
  if (!value) throw new Error("Core invariant refused");
}
async function check(name: Check, operation: () => Promise<boolean>) {
  running();
  receipt.stage = name;
  write();
  running();
  const passed = await operation();
  running();
  receipt.stage = name;
  checks[name] = passed ? "PASS" : "FAIL";
  write();
  running();
  if (!passed) {
    latch("check-refused");
    throw new Error("Core check refused");
  }
}
app.on("window-all-closed", () => {});
app.on("browser-window-created", (_event, window) => {
  owned.add(window);
  if (finishing)
    lateDestructions.add(
      destroy(window).then(
        () => true,
        () => false,
      ),
    );
});
app.on("web-contents-created", (_event, contents) => {
  contentsRetired.set(
    contents,
    new Promise<void>((resolve) => contents.once("destroyed", () => resolve())),
  );
  receipt.observations.allocations += 1;
  creationObserver?.(contents);
  if (contents.getType() === "webview") {
    receipt.observations.guestAllocations += 1;
    guestAllocation?.(contents);
  }
  write();
});
app.setPath("userData", Path.join(temporary, "user-data"));
app.setPath("sessionData", Path.join(temporary, "session-data"));
async function destroy(window: Electron.BaseWindow) {
  if (window.isDestroyed()) return;
  const closed = new Promise<void>((resolve) => window.once("closed", () => resolve()));
  let destroyed = Promise.resolve();
  if (window instanceof BrowserWindow && !window.webContents.isDestroyed()) {
    const contents = window.webContents;
    destroyed = new Promise<void>((resolve) => contents.once("destroyed", () => resolve()));
  }
  window.destroy();
  await Promise.all([closed, destroyed]);
}
async function finish() {
  if (finishing) return;
  finishing = true;
  executionAbort.abort();
  clearTimeout(watchdog);
  creationObserver = undefined;
  guestAllocation = undefined;
  receipt.cleanup = "pending";
  write();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const complete = await Promise.race([
      (async () => {
        await Promise.all([...owned].map(destroy));
        if (server)
          await new Promise<void>((resolve) => {
            server!.closeAllConnections();
            server!.close(() => resolve());
          });
        await effectsCleanup?.();
        const lateClosed = await Promise.all([...lateDestructions]);
        await Promise.all([...contentsRetired.values()]);
        return (
          lateClosed.every(Boolean) &&
          BaseWindow.getAllWindows().every((window) => window.isDestroyed()) &&
          webContents.getAllWebContents().every((contents) => contents.isDestroyed())
        );
      })(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 8000);
      }),
    ]);
    receipt.cleanup = complete ? "complete" : "timed-out";
  } catch {
    receipt.cleanup = "failed";
  } finally {
    clearTimeout(timer);
  }
  if (receipt.cleanup !== "complete")
    latch(receipt.cleanup === "timed-out" ? "cleanup-timeout" : "cleanup-failed");
  receipt.phase = "final";
  receipt.passed =
    receipt.firstFailure === null &&
    !receipt.diagnosticsWriteFailed &&
    receipt.cleanup === "complete" &&
    receipt.observations.blockedNetwork === 0 &&
    required.every((name) => checks[name] === "PASS");
  write(false);
  if (receipt.diagnosticsWriteFailed) {
    receipt.passed = false;
    write(false);
  }
  app.exit(receipt.passed ? 0 : 1);
}
const watchdog = setTimeout(() => {
  latch("child-watchdog");
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
const nonce = Crypto.randomBytes(16).toString("hex");
const signals = new Map<string, ReturnType<typeof deferred<void>>>();
const signal = (name: string) => {
  const value = deferred<void>();
  signals.set(name, value);
  return value.promise;
};
async function serve() {
  server = Http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/signal") {
      const name = url.searchParams.get("phase") ?? "";
      const milestone = signals.get(name);
      if (request.method !== "POST" || url.searchParams.get("nonce") !== nonce || !milestone) {
        response.writeHead(400);
        response.end();
        latch("unexpected-signal");
        void finish();
        return;
      }
      signals.delete(name);
      receipt.observations.signalRequests += 1;
      response.writeHead(204);
      response.end();
      milestone.resolve();
      write();
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'nonce-fixture'; connect-src 'self'; frame-src 'self'; style-src 'nonce-fixture'",
    );
    const phase =
      url.pathname === "/"
        ? "host"
        : url.pathname === "/guest"
          ? "guest"
          : url.pathname === "/popup"
            ? "popup"
            : null;
    if (!phase) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.end(
      `<!doctype html><meta charset="utf-8"><style nonce="fixture">html,body{width:100%;height:100%;margin:0}webview{display:flex;width:600px;height:400px}</style><script nonce="fixture">fetch('/signal?phase=${phase}&nonce=${nonce}',{method:'POST'})</script>`,
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  requireValue(address && typeof address !== "string");
  if (!address || typeof address === "string") throw new Error("Core loopback unavailable");
  origin = `http://127.0.0.1:${address.port}`;
}
const secured = new WeakSet<Electron.Session>();
async function constrain(target: Electron.Session) {
  if (secured.has(target)) return;
  secured.add(target);
  await target.setProxy({ mode: "direct" });
  running();
  target.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      details.url === "about:blank" ||
      details.url.startsWith(origin + "/") ||
      details.url.startsWith("t3code-dev://app/") ||
      details.url.startsWith("data:text/html");
    if (!allowed) {
      receipt.observations.blockedNetwork += 1;
      write();
    }
    callback({ cancel: !allowed });
  });
}

async function exercise(
  windows: ElectronWindow.ElectronWindow["Service"],
  manager: Manager.PreviewManager["Service"],
  desktop: DesktopWindow.DesktopWindow["Service"],
  profiles: BrowserSession.BrowserSession["Service"],
  protocol: ElectronProtocol.ElectronProtocol["Service"],
  applicationScope: Scope.Scope,
  runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
) {
  const wait = async <A>(promise: Promise<A>) => {
    const value = await promise;
    running();
    return value;
  };
  const run = <A, E>(effect: Effect.Effect<A, E>) => {
    running();
    return wait(runEffect(effect));
  };
  const acquire = windows.acquireUpdateRendererReservation;
  const reserve = windows.tryReserveRendererCreation;
  const activity = windows.tryReserveRuntimeActivity;
  requireValue(
    acquire &&
      reserve &&
      activity &&
      windows.canCreateUncorrelatedRenderer &&
      windows.updateInventory,
  );
  if (!acquire || !reserve || !activity) throw new Error("Native API absent");
  let sequence = 0;
  const hold = async () => {
    const scope = await run(Scope.fork(applicationScope, "sequential"));
    const found = await run(
      acquire({
        generation: `fixture-${++sequence}`,
        targetVersion: "0.0.0-fixture",
        expiresAt: Date.now() + 60000,
      }).pipe(Scope.provide(scope)),
    );
    return {
      token: Option.getOrUndefined(found),
      close: async () => {
        await run(Scope.close(scope, Exit.void));
      },
    };
  };
  const refuses = async () => {
    const attempt = await hold();
    const refused = attempt.token === undefined;
    await attempt.close();
    return refused;
  };
  await constrain(session.defaultSession);
  running();
  await run(
    protocol
      .registerDesktopProtocol({
        scheme: "t3code-dev",
        clerkFrontendApiHostname: undefined,
        targetOrigin: new URL(origin),
      })
      .pipe(Scope.provide(applicationScope)),
  );
  const ready = signal("host");
  const mainLoaded = deferred<void>();
  app.once("browser-window-created", (_event, window) => {
    const loaded = () => {
      if (window.webContents.getURL() !== "t3code-dev://app/") return;
      window.webContents.removeListener("did-finish-load", loaded);
      mainLoaded.resolve();
    };
    window.webContents.on("did-finish-load", loaded);
  });
  await run(desktop.handleBackendReady(new URL(origin)));
  await wait(ready);
  await wait(mainLoaded.promise);
  const mainOption = await run(windows.main);
  requireValue(Option.isSome(mainOption));
  if (Option.isNone(mainOption)) throw new Error("Production main absent");
  const main = mainOption.value,
    host = main.webContents;
  receipt.ids.main = main.id;
  receipt.ids.mainContents = host.id;
  const js = <A = unknown>(contents: WebContents, script: string) => {
    running();
    return wait(contents.executeJavaScript(script, true) as Promise<A>);
  };
  main.webContents.on("will-attach-webview", (event) => {
    receipt.observations.willAttach += 1;
    if (event.defaultPrevented) receipt.observations.preventedAttach += 1;
    write();
  });
  main.webContents.on("did-attach-webview", () => {
    receipt.observations.didAttach += 1;
    write();
  });
  await check(
    "productionMain",
    async () =>
      host.getType() === "window" &&
      !main.isDestroyed() &&
      host.getURL() === "t3code-dev://app/" &&
      (await run(windows.updateInventory!)).some((item) => item.id === host.id),
  );
  // All positive requests use actual native constructors; the service alone decides admission.
  const pending = reserve({ kind: "preview-pip", owner: host.id });
  requireValue(pending);
  if (!pending) throw new Error("Reservation absent");
  await check("pendingVeto", refuses);
  let exactNative: BrowserWindow;
  running();
  exactNative = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const exactContents = exactNative.webContents;
  await check("reservedNative", async () => {
    const bound = pending.bind(exactContents) && !pending.bind(exactContents);
    await wait(exactNative.loadURL("about:blank"));
    const fresh = await hold();
    const validBeforeRelease = fresh.token?.isValid() === true;
    await fresh.close();
    const stillAlive = !exactNative.isDestroyed() && !exactContents.isDestroyed();
    pending.release();
    pending.release();
    receipt.reservationCoverage.liveBoundReleaseRefused = stillAlive && (await refuses());
    await wait(destroy(exactNative));
    const afterDestroy = await hold();
    receipt.reservationCoverage.destroyedBindingRestored = afterDestroy.token?.isValid() === true;
    await afterDestroy.close();
    return (
      bound &&
      validBeforeRelease &&
      receipt.reservationCoverage.liveBoundReleaseRefused &&
      receipt.reservationCoverage.destroyedBindingRestored
    );
  });
  const first = await hold();
  requireValue(first.token?.isValid());
  await check("allocationRevokes", async () => {
    let observed = false;
    creationObserver = () => {
      observed = first.token?.isValid() === false && first.token.tryCommit() === false;
      receipt.observations.unknownAllocationRevokedSynchronously = observed;
    };
    running();
    const unknown = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    creationObserver = undefined;
    const invalid = observed && !first.token!.isValid();
    await wait(destroy(unknown));
    return invalid && !first.token!.isValid();
  });
  await check("oldTokenInvalid", async () => !first.token!.isValid() && !first.token!.tryCommit());
  await first.close();
  await check("unknownVeto", async () => {
    const cancelled = reserve({ kind: "preview-pip", owner: host.id });
    requireValue(cancelled);
    cancelled!.release();
    cancelled!.release();
    running();
    const unknown = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await check(
      "releasedBindingRefused",
      async () => cancelled!.bind(unknown.webContents) === false,
    );
    const newer = reserve({ kind: "preview-pip", owner: host.id });
    requireValue(newer);
    receipt.reservationCoverage.olderAllocationBindRefused =
      newer!.bind(unknown.webContents) === false;
    newer!.release();
    newer!.release();
    const denied = await refuses();
    await wait(destroy(unknown));
    const afterDestroy = await hold();
    const restored = afterDestroy.token?.isValid() === true;
    await afterDestroy.close();
    return receipt.reservationCoverage.olderAllocationBindRefused && denied && restored;
  });
  await check("scopeReplacement", async () => {
    const old = await hold();
    requireValue(old.token?.isValid());
    await old.close();
    const replacement = await hold();
    requireValue(replacement.token?.isValid());
    await old.close();
    const valid =
      !old.token!.isValid() &&
      replacement.token!.isValid() &&
      windows.canCreateUncorrelatedRenderer?.() === false &&
      reserve({ kind: "preview-pip", owner: host.id }) === undefined;
    await replacement.close();
    return valid && windows.canCreateUncorrelatedRenderer?.() === true;
  });
  const partition = await run(profiles.getPartition("core-admission", false, "profile"));
  await constrain(await run(profiles.getSession("core-admission", false, "profile")));
  running();
  const appendGuest = () =>
    js(
      host,
      `(()=>{const guest=document.createElement('webview');guest.id='core-guest';guest.setAttribute('partition',${JSON.stringify(partition)});guest.src=${JSON.stringify(origin + "/guest")};document.body.append(guest);return true;})()`,
    );
  await check("heldGuest", async () => {
    const held = await hold();
    requireValue(held.token?.isValid());
    const allocation = deferred<WebContents>(),
      destroyed = deferred<void>();
    const willBefore = receipt.observations.willAttach,
      didBefore = receipt.observations.didAttach;
    let revokedAtAllocation = false;
    guestAllocation = (contents) => {
      revokedAtAllocation = held.token?.isValid() === false;
      receipt.observations.preventedGuestAllocatedBeforeWill =
        receipt.observations.willAttach === willBefore;
      contents.once("destroyed", () => destroyed.resolve());
      allocation.resolve(contents);
    };
    await appendGuest();
    await wait(allocation.promise);
    await wait(destroyed.promise);
    guestAllocation = undefined;
    const denied =
      revokedAtAllocation &&
      receipt.observations.preventedGuestAllocatedBeforeWill &&
      receipt.observations.willAttach === willBefore + 1 &&
      receipt.observations.preventedAttach >= 1 &&
      receipt.observations.didAttach === didBefore &&
      !held.token!.isValid() &&
      !held.token!.tryCommit();
    await js(host, "document.getElementById('core-guest')?.remove();true");
    await held.close();
    return denied;
  });
  const guestReady = signal("guest"),
    attached = deferred<WebContents>(),
    guestLoaded = deferred<void>();
  host.once("did-attach-webview", (_event, contents) => {
    contents.once("did-finish-load", () => guestLoaded.resolve());
    attached.resolve(contents);
  });
  // Adversarial reservation cannot authorize a later unrelated renderer guest.
  const wrongKind = reserve({ kind: "preview-pip", owner: host.id });
  requireValue(wrongKind);
  await appendGuest();
  const guest = await wait(attached.promise);
  await wait(guestReady);
  await wait(guestLoaded.promise);
  receipt.ids.guest = guest.id;
  await check("adversarialGuestBind", async () => wrongKind!.bind(guest) === false);
  wrongKind!.release();
  await check(
    "guestUnknown",
    async () =>
      guest.getType() === "webview" &&
      guest.hostWebContents === host &&
      guest.session === (await run(profiles.getSession("core-admission", false, "profile"))) &&
      new URL(guest.getURL()).origin === origin &&
      (await run(windows.updateInventory!)).some((item) => item.id === guest.id) &&
      (await refuses()),
  );
  await run(manager.createTab("core-guest"));
  await run(manager.registerWebview("core-guest", guest.id));
  await check("sameGuestRefusesInstall", refuses);
  await check("guestPiP", async () => {
    const created = deferred<BrowserWindow>();
    const listener = (_event: Electron.Event, window: BrowserWindow) => created.resolve(window);
    app.once("browser-window-created", listener);
    await run(manager.openPictureInPicture("core-guest"));
    const pip = await wait(created.promise);
    receipt.ids.pip = pip.id;
    const live =
      !pip.isDestroyed() &&
      pip !== main &&
      pip.webContents !== guest &&
      pip.webContents.getURL().startsWith("data:text/html");
    const closed = new Promise<void>((resolve) => pip.once("closed", () => resolve()));
    const contentsDestroyed = new Promise<void>((resolve) =>
      pip.webContents.once("destroyed", () => resolve()),
    );
    await run(manager.closePictureInPicture("core-guest"));
    await wait(Promise.all([closed, contentsDestroyed]));
    return live && pip.isDestroyed();
  });
  await check("popupPositive", async () => {
    const created = deferred<BrowserWindow>(),
      popupLoaded = deferred<void>();
    guest.once("did-create-window", (window) => {
      window.webContents.once("did-finish-load", () => popupLoaded.resolve());
      created.resolve(window);
    });
    const popupReady = signal("popup");
    receipt.observations.popupRequests += 1;
    const returned = await js<boolean>(
      guest,
      `window.open(${JSON.stringify(origin + "/popup")},'core-popup','popup,width=240,height=160')!==null`,
    );
    const popup = await wait(created.promise);
    await wait(popupReady);
    await wait(popupLoaded.promise);
    receipt.ids.popup = popup.id;
    await check(
      "popupUnknown",
      async () =>
        (await run(windows.updateInventory!)).some((item) => item.id === popup.webContents.id) &&
        (await refuses()),
    );
    const sameOpener =
      popup.webContents.session === guest.session &&
      !popup.isDestroyed() &&
      (await js<boolean>(popup.webContents, "window.opener!==null"));
    await check("popupRetirement", async () => {
      await wait(destroy(popup));
      return popup.isDestroyed();
    });
    return returned && sameOpener;
  });
  await check("guestRetirement", async () => {
    const destroyed = new Promise<void>((resolve) => guest.once("destroyed", () => resolve()));
    await js(host, "document.getElementById('core-guest').remove();true");
    await wait(destroyed);
    await run(manager.closeTab("core-guest"));
    const fresh = await hold();
    const valid = fresh.token?.isValid() === true;
    await fresh.close();
    return valid;
  });
  // Both held-PiP and held-Manager-popup require this same live guest, which
  // prevents a hold. Neither is counted as an actual held consumer PASS.
  await check("activityVeto", async () => {
    const token = activity({ kind: "snapshot-capture" });
    requireValue(token);
    const denied = await refuses();
    token!.release();
    token!.release();
    const fresh = await hold();
    const valid = fresh.token?.isValid() === true;
    const heldDenied = activity({ kind: "snapshot-capture" }) === undefined;
    await fresh.close();
    return denied && valid && heldDenied;
  });
  await check("flashPositive", async () => {
    const created = deferred<Electron.BaseWindow>(),
      flashClosed = deferred<void>();
    const flash = new SnapShotFlash((window) => {
      owned.add(window);
      window.once("closed", () => flashClosed.resolve());
      window.showInactive();
      created.resolve(window);
    }, activity);
    running();
    await wait(flash.showStatic({ x: 0, y: 0, width: 32, height: 32 }));
    const window = await wait(created.promise);
    receipt.ids.flash = window.id;
    const live = BaseWindow.getAllWindows().includes(window) && !window.isDestroyed();
    const denied = await refuses();
    flash.dispose();
    await wait(flashClosed.promise);
    const fresh = await hold();
    const restored = fresh.token?.isValid() === true;
    await fresh.close();
    return live && denied && restored;
  });
  await check("heldFlash", async () => {
    const held = await hold();
    requireValue(held.token?.isValid());
    const before = BaseWindow.getAllWindows().map((window) => window.id);
    let shown = false;
    const flash = new SnapShotFlash((window) => {
      owned.add(window);
      window.showInactive();
      shown = true;
    }, activity);
    running();
    await wait(flash.showStatic({ x: 0, y: 0, width: 32, height: 32 }));
    const unchanged =
      !shown &&
      JSON.stringify(BaseWindow.getAllWindows().map((window) => window.id)) ===
        JSON.stringify(before);
    flash.dispose();
    await held.close();
    return unchanged;
  });
  // Only the canonical adapter is exercised. Public IO hooks never spawn a
  // helper, activate a closure, close this app or relaunch anything.
  const nixCase = async (boundary: "access" | "activation") => {
    const entered = deferred<void>(),
      completion = deferred<void>();
    let activated = false,
      relaunched = false;
    const adapter = new NixManagedUpdater({
      command: Path.join(temporary, "never-executed-helper"),
      launcher: Path.join(temporary, "never-executed-launcher"),
      currentVersion: "0.0.0",
      accessLauncher: async () => {
        if (boundary === "access") {
          entered.resolve();
          await completion.promise;
        }
      },
      run: async (args) => {
        if (args[0] === "--check") return JSON.stringify({ available: "0.0.1" });
        if (args[0] === "--activate") {
          activated = true;
          entered.resolve();
          await completion.promise;
        }
        return "";
      },
      relaunch: () => {
        relaunched = true;
      },
    });
    await wait(adapter.checkForUpdates());
    await wait(adapter.downloadUpdate());
    const held = await hold();
    requireValue(held.token?.isValid());
    const outcome = adapter
      .quitAndInstall(false, true, () => held.token!.isValid())
      .then(
        () => ({ rejected: false, divergence: false }),
        (error) => ({
          rejected: error instanceof NixUpdateAdmissionError,
          divergence:
            error instanceof NixUpdateAdmissionError &&
            error.selectedVersion === "0.0.1" &&
            error.runningVersion === "0.0.0",
        }),
      );
    await wait(entered.promise);
    running();
    const unknown = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const revoked = !held.token!.isValid();
    completion.resolve();
    const result = await wait(outcome);
    await wait(destroy(unknown));
    await held.close();
    return (
      revoked &&
      result.rejected &&
      !relaunched &&
      !main.isDestroyed() &&
      (boundary === "access" ? !activated && !result.divergence : activated && result.divergence)
    );
  };
  await check("nixAccessRevocation", () => nixCase("access"));
  await check("nixActivationRevocation", () => nixCase("activation"));
  await check("finalInventory", async () => {
    const fresh = await hold();
    const productionIds = (await run(windows.updateInventory!))
      .map((item) => item.id)
      .sort((a, b) => a - b);
    const windowIds = BaseWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .map((window) => window.id)
      .sort((a, b) => a - b);
    const contentsIds = webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed())
      .map((contents) => contents.id)
      .sort((a, b) => a - b);
    Object.assign(receipt.finalInventory, {
      productionContentsIds: productionIds,
      nativeWindowIds: windowIds,
      nativeContentsIds: contentsIds,
      expectedWindowId: main.id,
      expectedContentsId: host.id,
      tokenValid: fresh.token?.isValid() === true,
      holdRetained: fresh.token !== undefined,
    });
    // Keep this exact hold in the application scope until owned cleanup closes it.
    return (
      receipt.finalInventory.tokenValid &&
      productionIds.length === 1 &&
      productionIds[0] === host.id &&
      windowIds.length === 1 &&
      windowIds[0] === main.id &&
      contentsIds.length === 1 &&
      contentsIds[0] === host.id
    );
  });
}

async function main() {
  // Runs synchronously before this function reaches its first await.
  Effect.runSync(Effect.void.pipe(Effect.provide(ElectronProtocol.layerSchemePrivileges)));
  await check(
    "runtime",
    async () =>
      receipt.runtime.electron === "44.4.5" &&
      receipt.runtime.executable === binding.executable &&
      receipt.runtime.sha256 === binding.executableSha256 &&
      sha(FS.readFileSync(process.argv[1]!)) === binding.entrySha256 &&
      binding.scope === receipt.scope &&
      binding.nativePin === nativePin &&
      binding.nixPin === nixPin &&
      binding.consumerPin === consumerPin &&
      binding.source === process.env.GITHUB_SHA &&
      binding.runId === process.env.GITHUB_RUN_ID &&
      binding.job === process.env.GITHUB_JOB &&
      binding.privateDisplayBound &&
      binding.assertedRunnerProfile === "blacksmith-8vcpu-ubuntu-2404" &&
      sha(FS.readFileSync(binding.preload)) === binding.preloadSha256 &&
      sha(FS.readFileSync(Path.join(Path.dirname(binding.preload), "preview-pip-preload.cjs"))) ===
        binding.pipPreloadSha256 &&
      Object.entries(binding.sourceHashes).every(
        ([file, hash]) => sha(FS.readFileSync(Path.join(repo, file))) === hash,
      ) &&
      Object.entries(pinnedSourceHashes).every(
        ([file, hash]) => binding.sourceHashes[file] === hash,
      ),
  );
  await app.whenReady();
  running();
  await serve();
  running();
  const environment = Environment.layer({
    dirname: Path.dirname(binding.preload),
    homeDirectory: Path.join(temporary, "home"),
    platform: "linux",
    processArch: process.arch,
    appVersion: "0.0.0-fixture",
    appPath: repo,
    isPackaged: false,
    resourcesPath: Path.join(temporary, "resources"),
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provideMerge(Config.layerTest({ VITE_DEV_SERVER_URL: origin })),
    Layer.provideMerge(NodeServices.layer),
  );
  const unrelated = Layer.mergeAll(
    environment,
    Layer.succeed(HostProcess.Platform, "linux"),
    Settings.layerTest(),
    ElectronApp.layer,
    ElectronDialog.layer,
    ElectronTheme.layer,
    Layer.succeed(Assets.DesktopAssets, {
      iconPaths: Effect.succeed({
        ico: Option.none<string>(),
        icns: Option.none<string>(),
        png: Option.none<string>(),
      }),
      resolveResourcePath: () => Effect.succeedNone,
    }),
    Layer.succeed(ClientSettings.DesktopClientSettings, {
      get: Effect.succeedNone,
      set: () => Effect.void,
    }),
    Layer.succeed(History.DesktopRendererHistory, {
      register: () => Effect.void,
      recordMetrics: () => Effect.void,
      shutdown: Effect.void,
    }),
    Layer.succeed(ElectronMenu.ElectronMenu, {
      setApplicationMenu: () => Effect.void,
      popupTemplate: () => Effect.void,
      showContextMenu: () => Effect.succeedNone,
    }),
    Layer.succeed(ElectronShell.ElectronShell, {
      openExternal: () => Effect.succeed(false),
      openSystemSettings: () => Effect.succeed(false),
      copyText: () => Effect.void,
    }),
    Layer.succeed(Passkeys.PreviewPasskeys, {
      bridgeEnabled: false,
      configure: Effect.void,
      installSessionHandlers: () => {},
      attachGuest: () => () => {},
    }),
  );
  // Reuse this exact Layer identity: Window and Manager see the SAME native service.
  const native = ElectronWindow.layer.pipe(
    Layer.provideMerge(ElectronProtocol.layer),
    Layer.provideMerge(unrelated),
  );
  const preview = Manager.layer.pipe(
    Layer.provideMerge(BrowserHost.layer),
    Layer.provideMerge(BrowserSession.layer),
    Layer.provideMerge(native),
  );
  const application = DesktopWindow.layer.pipe(Layer.provideMerge(preview));
  const scope = await Effect.runPromise(Scope.make());
  effectsCleanup = () => Effect.runPromise(Scope.close(scope, Exit.void));
  const context = await Effect.runPromise(Layer.build(application).pipe(Scope.provide(scope)), {
    signal: executionAbort.signal,
  });
  running();
  const run = Effect.runPromiseWith(context);
  const services = await run(
    Effect.gen(function* () {
      return {
        windows: yield* ElectronWindow.ElectronWindow,
        manager: yield* Manager.PreviewManager,
        desktop: yield* DesktopWindow.DesktopWindow,
        profiles: yield* BrowserSession.BrowserSession,
        protocol: yield* ElectronProtocol.ElectronProtocol,
      };
    }),
    { signal: executionAbort.signal },
  );
  running();
  await exercise(
    services.windows,
    services.manager,
    services.desktop,
    services.profiles,
    services.protocol,
    scope,
    <A, E>(effect: Effect.Effect<A, E>) => run(effect, { signal: executionAbort.signal }),
  );
  running();
  await finish();
}
void main().catch(() => {
  latch("main-rejected");
  void finish();
});
