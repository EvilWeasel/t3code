/** CI-only synthetic transport fixture. Never imports desktop startup or real user state. */
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { app, BrowserWindow, type Session, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as DesktopRendererHistory from "../../telemetry/DesktopRendererHistory.ts";
import * as BrowserSession from "../BrowserSession.ts";
import * as DesktopBrowserHost from "../DesktopBrowserHost.ts";
import * as PreviewPasskeys from "../Passkeys.ts";
import * as PreviewManager from "../Manager.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../WebviewPreferences.ts";

class FixtureFailure extends Schema.TaggedError<FixtureFailure>()(
  "BrowserNativePostFixtureFailure",
  {
    stage: Schema.String,
  },
) {}

const CaseEvidence = Schema.Struct({
  kind: Schema.Literals(["encoded", "multipart"]),
  guestId: Schema.Number,
  popupId: Schema.Number,
  nativeDisposition: Schema.String,
  nativeWebview: Schema.Boolean,
  openerPreserved: Schema.Boolean,
  openerPolicy: Schema.Literal("explicit-rel-opener"),
  sameSession: Schema.Boolean,
  contextIsolation: Schema.Boolean,
  nodeIntegration: Schema.Boolean,
  sandbox: Schema.Boolean,
});
const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literals(["running", "passed", "failed"]),
  stage: Schema.String,
  failureCode: Schema.NullOr(Schema.String),
  sourceSha: Schema.String,
  electron: Schema.String,
  chrome: Schema.String,
  executableSha256: Schema.String,
  cases: Schema.Array(CaseEvidence),
  blockedRequests: Schema.Number,
  unexpectedNavigation: Schema.Number,
  openLinks: Schema.Number,
});
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(Receipt));

// Both guards precede app readiness and all window/session construction.
if (process.env.GITHUB_ACTIONS !== "true" || process.env.MORROWBYTE_CI_PROBE !== "1") {
  throw new Error("Integration-owned CI execution only");
}
const temporary = process.env.MORROWBYTE_NATIVE_POST_TEMP ?? "";
const output = process.env.MORROWBYTE_NATIVE_POST_OUTPUT ?? "";
const origin = process.env.MORROWBYTE_NATIVE_POST_ORIGIN ?? "";
NodeAssert.match(NodePath.basename(temporary), /^morrowbyte-native-post-/u);
NodeAssert.equal(
  NodeFS.readFileSync(NodePath.join(temporary, ".owned-probe"), "utf8"),
  "synthetic-only",
);
NodeAssert.equal(NodePath.isAbsolute(output), true);
NodeAssert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
app.setPath("userData", NodePath.join(temporary, "user-data"));
app.setPath("sessionData", NodePath.join(temporary, "session-data"));
app.setPath("home", NodePath.join(temporary, "home"));
app.setPath("downloads", NodePath.join(temporary, "downloads"));
app.on("window-all-closed", () => {});

const receipt: typeof Receipt.Type = {
  version: 1,
  status: "running",
  stage: "before-ready",
  failureCode: null,
  sourceSha: process.env.GITHUB_SHA ?? "",
  electron: process.versions.electron ?? "",
  chrome: process.versions.chrome ?? "",
  executableSha256: NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(process.execPath))
    .digest("hex"),
  cases: [],
  blockedRequests: 0,
  unexpectedNavigation: 0,
  openLinks: 0,
};
let current = receipt;
const windows = new Set<BrowserWindow>();
app.on("browser-window-created", (_event, window) => windows.add(window));
let finished = false;

// A synchronous flushed receipt survives scope finalizers and last-window teardown.
function persist(status: (typeof Receipt.Type)["status"], stage: string) {
  current = { ...current, status, stage, failureCode: status === "failed" ? stage : null };
  const name = status === "running" ? "fixture-receipt.partial.json" : "fixture-receipt.json";
  const destination = NodePath.join(output, name);
  const staging = `${destination}.tmp`;
  const fd = NodeFS.openSync(staging, "w");
  try {
    NodeFS.writeFileSync(fd, `${encodeReceipt(current)}\n`);
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
  NodeFS.renameSync(staging, destination);
  const directory = NodeFS.openSync(output, "r");
  try {
    NodeFS.fsyncSync(directory);
  } finally {
    NodeFS.closeSync(directory);
  }
}
function cleanup() {
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
}
function fail(stage: string) {
  if (finished) return;
  finished = true;
  persist("failed", stage);
  cleanup();
  app.exit(1);
}
process.on("uncaughtException", () => fail("uncaught-exception"));
process.on("unhandledRejection", () => fail("unhandled-rejection"));
process.on("SIGTERM", () => fail("runner-termination"));
const watchdog = NodeTimers.setTimeout(() => fail("fixture-watchdog"), 90_000);
persist("running", "before-ready");

function ownedUrl(raw: string) {
  try {
    return new URL(raw).origin === origin;
  } catch {
    return false;
  }
}
function guardSession(session: Session) {
  session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = ownedUrl(details.url);
    if (!allowed) current = { ...current, blockedRequests: current.blockedRequests + 1 };
    callback({ cancel: !allowed });
  });
}
function guardContents(contents: WebContents) {
  const guard = (event: Electron.Event, url: string) => {
    if (ownedUrl(url)) return;
    event.preventDefault();
    current = { ...current, unexpectedNavigation: current.unexpectedNavigation + 1 };
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
}
function eventPromise<A>(
  subscribe: (resolve: (value: A) => void, reject: (reason: Error) => void) => void,
) {
  return new Promise<A>(subscribe);
}
const asyncStep = <A>(stage: string, run: () => Promise<A>) =>
  Effect.sync(() => persist("running", stage)).pipe(
    Effect.flatMap(() =>
      Effect.tryPromise({ try: run, catch: () => new FixtureFailure({ stage }) }),
    ),
  );

const program = Effect.gen(function* () {
  yield* asyncStep("app-ready", () => app.whenReady());
  const path = yield* Path.Path;
  const dependencies = Layer.mergeAll(
    Layer.mock(DesktopEnvironment.DesktopEnvironment)({
      browserArtifactsDir: NodePath.join(temporary, "artifacts"),
      dirname: temporary,
      path,
    }),
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
    Layer.mock(ElectronDialog.ElectronDialog)({
      showMessageBox: () => Effect.die("Unexpected fixture dialog"),
    }),
    Layer.succeed(HostProcess.Platform, process.platform),
  );
  const services = PreviewManager.layer.pipe(
    Layer.provideMerge(DesktopBrowserHost.layer),
    Layer.provideMerge(BrowserSession.layer),
    Layer.provideMerge(dependencies),
  );
  yield* Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.subscribeOpenLinks(() =>
      Effect.sync(() => {
        current = { ...current, openLinks: current.openLinks + 1 };
      }),
    );
    const profileSession = yield* manager.getBrowserSession(
      "synthetic-native-post-profile",
      true,
      "profile",
    );
    const partition = yield* manager.getBrowserPartition(
      "synthetic-native-post-profile",
      true,
      "profile",
    );
    NodeAssert.match(partition, /^persist:t3code-preview-profile-[a-f0-9]{20}$/u);
    guardSession(profileSession);
    yield* asyncStep("synthetic-cookie", () =>
      profileSession.cookies.set({
        url: origin,
        name: "native_post_fixture",
        value: "synthetic-only",
        sameSite: "lax",
      }),
    );
    for (const kind of ["encoded", "multipart"] as const) {
      persist("running", `case-${kind}`);
      const parentUrl = `${origin}/form/${kind}`;
      const hostSession = yield* manager.getBrowserSession(`synthetic-host-${kind}`, false);
      guardSession(hostSession);
      const host = new BrowserWindow({
        show: false,
        webPreferences: {
          session: hostSession,
          webviewTag: true,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      windows.add(host);
      guardContents(host.webContents);
      const attached = eventPromise<{ guest: WebContents; loaded: Promise<void> }>(
        (resolve, reject) => {
          host.webContents.once("did-attach-webview", (_event, guest) => {
            guardContents(guest);
            const loaded = eventPromise<void>((loaded, failed) => {
              guest.once("did-finish-load", () => loaded());
              guest.once("did-fail-load", () => failed(new Error("Fixture guest load failed")));
            });
            // Attach a rejection handler immediately, even before registration awaits it.
            void loaded.catch(() => {});
            resolve({ guest, loaded });
          });
          host.webContents.once("destroyed", () => reject(new Error("Fixture host destroyed")));
        },
      );
      void attached.catch(() => {});
      host.webContents.on("will-attach-webview", (event, preferences, params) => {
        if (params.partition !== partition || params.src !== parentUrl || preferences.preload) {
          event.preventDefault();
          return;
        }
        // Match the production guest preferences; native popup must still override isolation.
        preferences.contextIsolation = false;
        preferences.nodeIntegrationInSubFrames = false;
        preferences.nodeIntegration = false;
        preferences.sandbox = true;
      });
      yield* manager.setMainWindow(host);
      yield* manager.createTab(`native_post_${kind}`);
      yield* asyncStep("host-load", () => host.loadURL(`${origin}/host`));
      // Only our static synthetic host is evaluated; no product/user renderer is inspected.
      yield* asyncStep("attach-webview", () =>
        host.webContents.executeJavaScript(`
        const guest = document.createElement('webview');
        guest.setAttribute('partition', '${partition}');
        guest.setAttribute('allowpopups', 'true');
        guest.setAttribute('webpreferences', '${PREVIEW_WEBVIEW_PREFERENCES}');
        guest.setAttribute('src', '${parentUrl}');
        document.body.appendChild(guest); true;
      `),
      );
      const { guest, loaded } = yield* asyncStep("guest-created", () => attached);
      persist("running", "native-guest-evidence");
      NodeAssert.equal(guest.getType(), "webview");
      NodeAssert.equal(guest.session, profileSession);
      yield* asyncStep("guest-loaded", () => loaded);
      NodeAssert.equal(guest.getURL(), parentUrl);
      yield* manager.registerWebview(`native_post_${kind}`, guest.id);
      const popupCreated = eventPromise<{
        popup: BrowserWindow;
        loaded: Promise<void>;
        disposition: string;
      }>((resolve, reject) => {
        guest.once("did-create-window", (popup, details) => {
          windows.add(popup);
          guardContents(popup.webContents);
          if (!ownedUrl(details.url)) {
            reject(new Error("Non-owned popup"));
            return;
          }
          const loaded =
            popup.webContents.getURL() === `${origin}/return/${kind}` &&
            !popup.webContents.isLoadingMainFrame()
              ? Promise.resolve()
              : eventPromise<void>((loaded, failed) => {
                  popup.webContents.once("did-finish-load", () => loaded());
                  popup.webContents.once("did-fail-load", () =>
                    failed(new Error("Fixture popup load failed")),
                  );
                });
          void loaded.catch(() => {});
          resolve({ popup, loaded, disposition: details.disposition });
        });
      });
      void popupCreated.catch(() => {});
      // Native Chromium form submission invokes the production-installed callback.
      yield* asyncStep("form-submit", () =>
        guest.executeJavaScript("document.forms[0].requestSubmit(); true;"),
      );
      const {
        popup,
        loaded: popupLoaded,
        disposition,
      } = yield* asyncStep("native-popup", () => popupCreated);
      yield* asyncStep("popup-loaded", () => popupLoaded);
      NodeAssert.equal(popup.webContents.getURL(), `${origin}/return/${kind}`);
      const openerPreserved = yield* asyncStep("opener-handshake", () =>
        popup.webContents.executeJavaScript<boolean>(`
        new Promise(resolve => {
          const expected = '${origin}';
          const nonce = 'native-post-${kind}';
          if (!window.opener || window.opener.location.href !== '${parentUrl}') return resolve(false);
          window.addEventListener('message', event => {
            if (event.origin === expected && event.source === window.opener && event.data === nonce + ':ack') resolve(true);
          });
          window.opener.postMessage(nonce, expected);
        })
      `),
      );
      persist("running", "opener-session-evidence");
      NodeAssert.equal(openerPreserved, true);
      NodeAssert.equal(guest.getURL(), parentUrl);
      NodeAssert.equal(popup.webContents.session, profileSession);
      persist("running", "native-popup-hardening-evidence");
      const prefs = popup.webContents.getLastWebPreferences();
      NodeAssert.equal(prefs.contextIsolation, true);
      NodeAssert.equal(prefs.nodeIntegration, false);
      NodeAssert.equal(prefs.sandbox, true);
      current = {
        ...current,
        cases: [
          ...current.cases,
          {
            kind,
            guestId: guest.id,
            popupId: popup.webContents.id,
            nativeDisposition: disposition,
            nativeWebview: true,
            openerPreserved: true,
            openerPolicy: "explicit-rel-opener",
            sameSession: true,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        ],
      };
      persist("running", `case-${kind}-complete`);
    }
    persist("running", "fixture-completeness-evidence");
    NodeAssert.equal(current.blockedRequests, 0);
    NodeAssert.equal(current.unexpectedNavigation, 0);
    NodeAssert.equal(current.openLinks, 0);
    NodeAssert.equal(current.cases.length, 2);
    NodeAssert.equal(windows.size, 4, "Exactly two fixture hosts and two native popups");
  }).pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        persist(
          Exit.isSuccess(exit) ? "passed" : "failed",
          Exit.isSuccess(exit) ? "complete" : current.stage,
        );
      }),
    ),
    Effect.provide(services),
  );
}).pipe(
  // Deliberately inside Effect.scoped: finalizers may destroy the last window.
  Effect.onExit((exit) =>
    Effect.sync(() => {
      persist(
        Exit.isSuccess(exit) ? "passed" : "failed",
        Exit.isSuccess(exit) ? "complete" : current.stage,
      );
    }),
  ),
  Effect.scoped,
  Effect.provide(Layer.mergeAll(NodeCryptoLayer.layer, NodeFileSystem.layer, Path.layer)),
);
void Effect.runPromise(program).then(
  () => {
    finished = true;
    NodeTimers.clearTimeout(watchdog);
    cleanup();
    app.exit(0);
  },
  () => fail(current.stage),
);
