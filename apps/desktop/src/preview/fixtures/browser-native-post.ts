/** CI-only synthetic transport fixture. Never imports desktop startup or real user state. */
import * as NodeAssert from "node:assert/strict";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { app, BrowserWindow, type Session, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
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

const NativeAttestation = Schema.Struct({
  nonce: Schema.String,
  contextIsolation: Schema.Boolean,
  sandbox: Schema.Boolean,
});
const decodeAttestation = Schema.decodeUnknownOption(NativeAttestation);
const MainWorldFacts = Schema.Struct({
  requireAbsent: Schema.Boolean,
  processAbsent: Schema.Boolean,
});
const ATTESTATION_CHALLENGE = "morrowbyte-native-post-challenge";
const ATTESTATION_REPORT = "morrowbyte-native-post-report";
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
  hardeningAttestation: Schema.Literal("session-preload-native-process"),
  requireAbsent: Schema.Boolean,
  processAbsent: Schema.Boolean,
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
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(Receipt));
const path = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));

// Both guards precede app readiness and all window/session construction.
if (process.env.GITHUB_ACTIONS !== "true" || process.env.MORROWBYTE_CI_PROBE !== "1") {
  throw new Error("Integration-owned CI execution only");
}
const temporary = process.env.MORROWBYTE_NATIVE_POST_TEMP ?? "";
const output = process.env.MORROWBYTE_NATIVE_POST_OUTPUT ?? "";
const origin = process.env.MORROWBYTE_NATIVE_POST_ORIGIN ?? "";
const nonces = {
  encoded: process.env.MORROWBYTE_NATIVE_POST_NONCE_ENCODED ?? "",
  multipart: process.env.MORROWBYTE_NATIVE_POST_NONCE_MULTIPART ?? "",
};
for (const nonce of Object.values(nonces)) NodeAssert.match(nonce, /^[a-f0-9-]{36}$/u);
NodeAssert.notEqual(nonces.encoded, nonces.multipart);
NodeAssert.match(path.basename(temporary), /^morrowbyte-native-post-/u);
NodeAssert.equal(path.isAbsolute(temporary), true);
NodeAssert.equal(path.isAbsolute(output), true);
NodeAssert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
app.setPath("userData", path.join(temporary, "user-data"));
app.setPath("sessionData", path.join(temporary, "session-data"));
app.setPath("home", path.join(temporary, "home"));
app.setPath("downloads", path.join(temporary, "downloads"));
app.on("window-all-closed", () => {});

async function runFixture() {
  const platformServices = Layer.mergeAll(NodeCryptoLayer.layer, NodeFileSystem.layer, Path.layer);
  const { fileSystem, crypto } = await Effect.runPromise(
    Effect.gen(function* () {
      return { fileSystem: yield* FileSystem.FileSystem, crypto: yield* Crypto.Crypto };
    }).pipe(Effect.provide(platformServices)),
  );
  NodeAssert.equal(
    await Effect.runPromise(fileSystem.readFileString(path.join(temporary, ".owned-probe"))),
    "synthetic-only",
  );
  const executable = await Effect.runPromise(fileSystem.readFile(process.execPath));
  const executableSha256 = Hex.encode(
    await Effect.runPromise(crypto.digest("SHA-256", executable)),
  );
  const receipt: typeof Receipt.Type = {
    version: 1,
    status: "running",
    stage: "before-ready",
    failureCode: null,
    sourceSha: process.env.GITHUB_SHA ?? "",
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    executableSha256,
    cases: [],
    blockedRequests: 0,
    unexpectedNavigation: 0,
    openLinks: 0,
  };
  let current = receipt;
  const windows = new Set<BrowserWindow>();
  app.on("browser-window-created", (_event, window) => windows.add(window));
  let finished = false;
  let terminating = false;
  const attestationCleanups = new Set<() => void>();

  // Serialize and flush every receipt before callers may tear down native resources.
  let persistence = Promise.resolve();
  function persist(status: (typeof Receipt.Type)["status"], stage: string) {
    if (terminating && status !== "failed")
      return Promise.reject(new FixtureFailure({ stage: "fixture-terminated" }));
    current = { ...current, status, stage, failureCode: status === "failed" ? stage : null };
    const snapshot = current;
    const name = status === "running" ? "fixture-receipt.partial.json" : "fixture-receipt.json";
    const destination = path.join(output, name);
    persistence = persistence.then(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const text = yield* encodeReceipt(snapshot);
          const file = yield* fileSystem.open(`${destination}.tmp`, { flag: "w" });
          yield* file.writeAll(new TextEncoder().encode(`${text}\n`));
          yield* file.sync;
          yield* fileSystem.rename(`${destination}.tmp`, destination);
          const directory = yield* fileSystem.open(output, { flag: "r" });
          yield* directory.sync;
        }).pipe(Effect.scoped),
      ),
    );
    return persistence;
  }
  function cleanup() {
    let complete = true;
    for (const detach of attestationCleanups) {
      try {
        detach();
      } catch {
        complete = false;
      }
    }
    for (const window of windows) {
      try {
        if (!window.isDestroyed()) window.destroy();
      } catch {
        complete = false;
      }
    }
    return complete;
  }
  async function fail(stage: string) {
    if (finished) return;
    finished = true;
    terminating = true;
    try {
      await persist("failed", stage);
    } finally {
      const cleaned = cleanup();
      try {
        if (!cleaned) await persist("failed", "fixture-cleanup-failed");
      } finally {
        app.exit(1);
      }
    }
  }
  process.on("uncaughtException", () => void fail("uncaught-exception"));
  process.on("unhandledRejection", () => void fail("unhandled-rejection"));
  process.on("SIGTERM", () => void fail("runner-termination"));
  const watchdog = Effect.runFork(
    Effect.sleep("90 seconds").pipe(
      Effect.flatMap(() => Effect.promise(() => fail("fixture-watchdog"))),
    ),
  );
  await persist("running", "before-ready");

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
    Effect.tryPromise({
      try: async () => {
        await persist("running", stage);
        return run();
      },
      catch: () => new FixtureFailure({ stage }),
    });
  const checkpoint = (stage: string) => asyncStep(stage, () => Promise.resolve());

  const program = Effect.gen(function* () {
    yield* asyncStep("app-ready", () => app.whenReady());
    const path = yield* Path.Path;
    const dependencies = Layer.mergeAll(
      DesktopEnvironment.layer({
        dirname: path.join(temporary, "app", "dist-electron"),
        homeDirectory: path.join(temporary, "home"),
        platform: process.platform,
        processArch: process.arch,
        isPackaged: true,
        appVersion: "0.0.0",
        appPath: path.join(temporary, "app"),
        resourcesPath: path.join(temporary, "resources"),
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          DesktopConfig.layerTest({
            T3CODE_HOME: path.join(temporary, "t3-home"),
            XDG_CONFIG_HOME: path.join(temporary, "home", ".config"),
            XDG_DATA_HOME: path.join(temporary, "home", ".local", "share"),
          }),
        ),
      ),
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
      const preloadId = profileSession.registerPreloadScript({
        type: "frame",
        filePath: path.join(temporary, "native-post-attestation.cjs"),
      });
      let preloadRemoved = false;
      const removePreload = () => {
        if (preloadRemoved) return;
        preloadRemoved = true;
        attestationCleanups.delete(removePreload);
        profileSession.unregisterPreloadScript(preloadId);
      };
      attestationCleanups.add(removePreload);
      yield* Effect.addFinalizer(() => Effect.sync(removePreload));
      yield* asyncStep("synthetic-cookie", () =>
        profileSession.cookies.set({
          url: origin,
          name: "native_post_fixture",
          value: "synthetic-only",
          sameSite: "lax",
        }),
      );
      for (const kind of ["encoded", "multipart"] as const) {
        yield* checkpoint(`case-${kind}`);
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
        yield* checkpoint("native-guest-evidence");
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
          popup.webContents.executeJavaScript(`
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
        yield* checkpoint("opener-session-evidence");
        NodeAssert.equal(openerPreserved, true);
        NodeAssert.equal(guest.getURL(), parentUrl);
        NodeAssert.equal(popup.webContents.session, profileSession);
        yield* checkpoint("native-popup-hardening-evidence");
        const contents = popup.webContents;
        const frame = contents.mainFrame;
        const returnUrl = `${origin}/return/${kind}`;
        let removeAttestationListeners = () => {};
        let attestationStale = false;
        const attested = eventPromise<typeof NativeAttestation.Type>((resolve, reject) => {
          let consumed = false;
          const navigationChanged = () => {
            attestationStale = true;
            reject(new Error("Attestation navigation changed"));
          };
          const report = (event: Electron.IpcMainEvent, raw: unknown) => {
            if (
              consumed ||
              attestationStale ||
              event.sender !== contents ||
              event.sender.session !== profileSession ||
              event.senderFrame !== frame ||
              contents.mainFrame !== frame ||
              frame.url !== returnUrl ||
              contents.getURL() !== returnUrl
            )
              return;
            const decoded = decodeAttestation(raw);
            if (Option.isNone(decoded) || decoded.value.nonce !== nonces[kind]) return;
            consumed = true;
            contents.ipc.off(ATTESTATION_REPORT, report);
            resolve(decoded.value);
          };
          let listenersRemoved = false;
          removeAttestationListeners = () => {
            if (listenersRemoved) return;
            listenersRemoved = true;
            attestationCleanups.delete(removeAttestationListeners);
            contents.ipc.off(ATTESTATION_REPORT, report);
            contents.off("did-start-navigation", navigationChanged);
          };
          attestationCleanups.add(removeAttestationListeners);
          contents.ipc.on(ATTESTATION_REPORT, report);
          contents.on("did-start-navigation", navigationChanged);
        });
        void attested.catch(() => {});
        yield* Effect.addFinalizer(() => Effect.sync(removeAttestationListeners));
        contents.send(ATTESTATION_CHALLENGE, nonces[kind]);
        const nativeFacts = yield* asyncStep("native-process-attestation", () => attested);
        const mainWorld = yield* Schema.decodeUnknownEffect(MainWorldFacts)(
          yield* asyncStep("native-main-world-node-facts", () =>
            contents.executeJavaScript(
              "({ requireAbsent: typeof require === 'undefined', processAbsent: typeof process === 'undefined' })",
            ),
          ),
        );
        yield* checkpoint("native-hardening-assertions");
        NodeAssert.equal(nativeFacts.contextIsolation, true);
        NodeAssert.equal(nativeFacts.sandbox, true);
        NodeAssert.equal(mainWorld.requireAbsent, true);
        NodeAssert.equal(mainWorld.processAbsent, true);
        NodeAssert.equal(attestationStale, false);
        NodeAssert.equal(contents.mainFrame, frame);
        NodeAssert.equal(frame.url, returnUrl);
        NodeAssert.equal(contents.getURL(), returnUrl);
        NodeAssert.equal(contents.session, profileSession);
        removeAttestationListeners();
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
              contextIsolation: nativeFacts.contextIsolation,
              nodeIntegration: !(mainWorld.requireAbsent && mainWorld.processAbsent),
              sandbox: nativeFacts.sandbox,
              hardeningAttestation: "session-preload-native-process",
              requireAbsent: mainWorld.requireAbsent,
              processAbsent: mainWorld.processAbsent,
            },
          ],
        };
        yield* checkpoint(`case-${kind}-complete`);
      }
      yield* checkpoint("fixture-completeness-evidence");
      NodeAssert.equal(current.blockedRequests, 0);
      NodeAssert.equal(current.unexpectedNavigation, 0);
      NodeAssert.equal(current.openLinks, 0);
      NodeAssert.equal(current.cases.length, 2);
      NodeAssert.equal(windows.size, 4, "Exactly two fixture hosts and two native popups");
    }).pipe(
      Effect.onExit((exit) =>
        Effect.promise(() =>
          persist(
            Exit.isSuccess(exit) ? "passed" : "failed",
            Exit.isSuccess(exit) ? "complete" : current.stage,
          ),
        ),
      ),
      Effect.provide(services),
    );
  }).pipe(
    // Deliberately inside Effect.scoped: finalizers may destroy the last window.
    Effect.onExit((exit) =>
      Effect.promise(() =>
        persist(
          Exit.isSuccess(exit) ? "passed" : "failed",
          Exit.isSuccess(exit) ? "complete" : current.stage,
        ),
      ),
    ),
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeCryptoLayer.layer, NodeFileSystem.layer, Path.layer)),
  );
  try {
    await Effect.runPromise(program);
    if (terminating) return;
    finished = true;
    await Effect.runPromise(Fiber.interrupt(watchdog));
    if (!cleanup()) {
      await persist("failed", "fixture-cleanup-failed");
      app.exit(1);
    } else app.exit(0);
  } catch {
    await fail(current.stage);
  }
}
void runFixture().catch(() => app.exit(1));
