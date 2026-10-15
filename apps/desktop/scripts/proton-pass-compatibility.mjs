/** Namespace-only synthetic Electron probe. Never imports Proton or reads a real profile. */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

const fixtureDirectory = NodeURL.fileURLToPath(
  new URL("./fixtures/proton-pass-compatibility/", import.meta.url),
);
export const expectedElectron = "44.4.5";
export const protonReference = {
  repository: "https://github.com/ProtonMail/WebClients",
  commit: "cdd6b6580ac95e978df14a897a5263543352d769",
  manifest: "applications/pass-extension/manifest-chrome.json",
  version: "1.42.0",
  requiredPaths: {
    "MV3 worker": "applications/pass-extension/src/app/worker/index.ts",
    "alarms/permissions": "applications/pass-extension/src/app/worker/services/activation.ts",
    "sender/tab/frame identity": "applications/pass-extension/src/lib/utils/sender.ts",
    "frame traversal/autofill": "applications/pass-extension/src/app/worker/services/autofill.ts",
    "popup/current tab": "applications/pass-extension/src/lib/utils/popup.ts",
    "storage.session with memory fallback": "packages/pass/lib/extension/storage/session.ts",
    "offscreen (clipboard only, not an autofill prerequisite)":
      "applications/pass-extension/src/app/worker/offscreen/offscreen.utils.ts",
  },
};

export function classifyContentMapping(observation, expected) {
  if (observation.type !== "content")
    return { status: "unknown", reason: "No content-to-worker roundtrip" };
  const frame = expected.frames.find((entry) => entry.url === observation.href);
  if (!frame) return { status: "unknown", reason: "No matching native frame" };
  const nativeFrameId = frame.main ? 0 : frame.frameTreeNodeId;
  if (!Number.isInteger(nativeFrameId))
    return { status: "unknown", reason: "Native frame identifier unavailable" };
  return {
    status:
      observation.sender.tabId === expected.tabId &&
      observation.sender.frameId === nativeFrameId &&
      observation.sender.url === frame.url
        ? "supported"
        : "unsupported",
    actual: observation.sender,
    expected: { tabId: expected.tabId, frameId: nativeFrameId, url: frame.url },
  };
}

export function receiptFailures(receipt) {
  const failures = [];
  if (receipt.runtime?.electron !== expectedElectron) failures.push("Wrong Electron runtime");
  if (!/^[a-f0-9]{64}$/.test(receipt.runtime?.executableSha256 ?? ""))
    failures.push("Missing executable hash");
  if (receipt.externalRequests?.length !== 0) failures.push("Unexpected network request");
  for (const name of [
    "workerBoot",
    "popupSameSession",
    "profileIsolation",
    "incognitoRejected",
    "mainFrameMapping",
    "subframeMapping",
    "redirectMapping",
    "focusMapping",
    "tabSeparation",
  ])
    if (receipt.invariants?.[name] !== true) failures.push(`Unproven invariant: ${name}`);
  if (!receipt.apiProfiles?.A || !receipt.apiProfiles?.B)
    failures.push("Missing API profile observations");
  if (receipt.fatalError) failures.push("Probe did not finish");
  if (receipt.phase !== undefined && receipt.phase !== "final") failures.push("Receipt is partial");
  if (receipt.cleanup?.status !== undefined && receipt.cleanup.status !== "complete")
    failures.push("Cleanup did not complete");
  if (receipt.persistenceErrors?.length) failures.push("Receipt persistence failed");
  return failures;
}

const hash = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const errorText = (error) => String(error).slice(0, 400);
const deadline = async (operation, label, milliseconds = 10000) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Serialization is independently testable; it proves no Electron/API behavior. */
export function serializeProbeReceipt(receipt, phase, cleanup, exitCode) {
  const snapshot = { ...receipt, phase, cleanup, officialProtonSupport: "unknown" };
  const failures = receiptFailures(snapshot);
  return JSON.stringify(
    {
      ...snapshot,
      failures,
      harnessPassed: phase === "final" && exitCode === 0 && failures.length === 0,
    },
    null,
    2,
  );
}

/** Flush before returning so closing a last window cannot discard diagnostics. */
export function persistProbeReceipt(output, serialized, preservePartial = false) {
  NodeFS.mkdirSync(output, { recursive: true });
  const writeFlushed = (file, flags) => {
    const descriptor = NodeFS.openSync(file, flags, 0o600);
    try {
      NodeFS.writeFileSync(descriptor, serialized);
      NodeFS.fsyncSync(descriptor);
    } finally {
      NodeFS.closeSync(descriptor);
    }
  };
  // Exclusive creation keeps the first partial failure even if finalization fails.
  if (preservePartial) writeFlushed(NodePath.join(output, "fixture-receipt.partial.json"), "wx");
  const target = NodePath.join(output, "fixture-receipt.json");
  const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    writeFlushed(temporary, "wx");
    NodeFS.renameSync(temporary, target);
  } finally {
    if (NodeFS.existsSync(temporary)) NodeFS.unlinkSync(temporary);
  }
  if (NodeOS.type() !== "Windows_NT") {
    const directory = NodeFS.openSync(output, "r");
    try {
      NodeFS.fsyncSync(directory);
    } finally {
      NodeFS.closeSync(directory);
    }
  }
}

export async function runProbe() {
  // Starting this script on a workstation must fail before Electron app readiness.
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.MORROWBYTE_NAMESPACE_PROBE !== "1")
    throw new Error(
      "Run only in the integration-owned Namespace Actions job with MORROWBYTE_NAMESPACE_PROBE=1",
    );
  const output = NodePath.resolve(process.argv[process.argv.indexOf("--output") + 1] ?? "");
  if (!process.argv.includes("--output") || output === process.cwd())
    throw new Error("Provide --output <artifact directory>");
  const temporary = process.env.MORROWBYTE_PROBE_TEMP_ROOT;
  if (!temporary || !NodePath.basename(temporary).startsWith("morrowbyte-proton-probe-"))
    throw new Error("Runner must supply an owned temporary root");
  if (NodeFS.readFileSync(NodePath.join(temporary, ".owned-probe"), "utf8") !== "synthetic-only")
    throw new Error("Missing temporary root ownership marker");
  const { app, BrowserWindow, session, webContents } = await import("electron");
  // Electron otherwise calls app.quit() when cleanup destroys the last window.
  // Only this probe owns its lifecycle; explicit app.exit follows receipt flush.
  app.on("window-all-closed", () => {});
  app.setPath("userData", NodePath.join(temporary, "user-data"));
  app.setPath("sessionData", NodePath.join(temporary, "session-data"));
  const receipt = {
    scope:
      "Synthetic extension and owned loopback pages only; not official Proton, autofill, account or installed-client acceptance",
    officialProton: protonReference,
    apiStatusMeaning:
      "supported = the named real call/listener registration succeeded; event delivery and mapping are separate observations, never a whole-extension support claim",
    untestedOptionalAPIs: [
      "nativeMessaging (no grant)",
      "privacy",
      "clipboardRead",
      "clipboardWrite",
      "webRequestAuthProvider",
    ],
    source: {
      githubSha: process.env.GITHUB_SHA ?? null,
      scriptSha256: hash(await NodeFSP.readFile(NodeURL.fileURLToPath(import.meta.url))),
    },
    runtime: {
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      executable: await NodeFSP.realpath(process.execPath),
      executableSha256: hash(await NodeFSP.readFile(process.execPath)),
      platform: NodeOS.type(),
      machine: NodeOS.machine(),
    },
    runner: {
      runId: process.env.GITHUB_RUN_ID ?? null,
      job: process.env.GITHUB_JOB ?? null,
      name: process.env.RUNNER_NAME ?? null,
      namespaceProfile: process.env.MORROWBYTE_NAMESPACE_PROFILE ?? null,
    },
    fixtureHashes: {},
    externalRequests: [],
    invariants: {},
    apiProfiles: {},
    observations: [],
    mappings: [],
  };
  const servers = [];
  const ownedSessions = [];
  const windows = [];
  const events = [];
  const waiters = new Set();
  const runToken = NodeCrypto.randomUUID();
  const record = (value) => {
    events.push(value);
    for (const notify of waiters) notify();
  };
  const waitFor = (predicate, name) =>
    deadline(
      new Promise((resolve) => {
        const check = () => {
          const result = predicate();
          if (result) {
            waiters.delete(check);
            resolve(result);
          }
        };
        waiters.add(check);
        check();
      }),
      name,
    );
  let origins = [];
  const assets = {};
  let exitCode = 1;
  let finishPromise;
  let requestedExitCode = 0;
  const noteFatal = (error) => {
    receipt.fatalError ??= errorText(error);
    process.stderr.write(`Probe failure at ${receipt.stage ?? "unknown"}: ${errorText(error)}\n`);
  };
  const watchdog = setTimeout(() => {
    noteFatal(new Error("Overall 110s probe deadline exceeded"));
    void finish(1);
  }, 110000);
  function finish(code) {
    if (code !== 0) requestedExitCode = 1;
    if (finishPromise) return finishPromise;
    clearTimeout(watchdog);
    // Store the shared promise before cleanup can trigger lifecycle callbacks.
    finishPromise = Promise.resolve()
      .then(async () => {
        const cleanup = { status: "pending", errors: [] };
        const save = (phase, preservePartial = false) => {
          receipt.observations = [...events];
          try {
            const serialized = serializeProbeReceipt(receipt, phase, cleanup, requestedExitCode);
            persistProbeReceipt(output, serialized, preservePartial);
            return JSON.parse(serialized);
          } catch (error) {
            requestedExitCode = 1;
            (receipt.persistenceErrors ??= []).push(errorText(error));
            process.stderr.write(`Receipt ${phase} persistence failed: ${errorText(error)}\n`);
            return null;
          }
        };
        // Flush both snapshots before ANY cleanup; a write failure forces a failed result.
        save("partial", true);
        if (receipt.fatalError)
          process.stderr.write(`First probe failure: ${receipt.fatalError}\n`);
        const cleanupOperation = async () => {
          for (const window of windows) {
            try {
              if (!window.isDestroyed()) window.destroy();
            } catch (error) {
              cleanup.errors.push(errorText(error));
            }
          }
          // These are exclusively this run's temporary sessions.
          for (const browserSession of ownedSessions) {
            try {
              for (const extension of browserSession.extensions.getAllExtensions())
                browserSession.extensions.removeExtension(extension.id);
            } catch (error) {
              cleanup.errors.push(errorText(error));
            }
            try {
              await browserSession.closeAllConnections();
            } catch (error) {
              cleanup.errors.push(errorText(error));
            }
          }
          await Promise.all(
            servers.map(
              (server) =>
                new Promise((resolve) => {
                  try {
                    server.closeAllConnections();
                    server.close((error) => {
                      if (error) cleanup.errors.push(errorText(error));
                      resolve();
                    });
                  } catch (error) {
                    cleanup.errors.push(errorText(error));
                    resolve();
                  }
                }),
            ),
          );
        };
        try {
          await deadline(cleanupOperation(), "Probe cleanup", 8000);
          cleanup.status = cleanup.errors.length ? "failed" : "complete";
        } catch (error) {
          cleanup.status = "timed-out";
          cleanup.errors.push(errorText(error));
        }
        if (cleanup.status !== "complete") {
          requestedExitCode = 1;
          process.stderr.write(`Probe cleanup ${cleanup.status}: ${cleanup.errors.join("; ")}\n`);
        }
        const finalReceipt = save("final");
        // Parent's 130s bound and owned-temp cleanup remain the final backstop.
        app.exit(finalReceipt?.harnessPassed ? 0 : 1);
      })
      .catch((error) => {
        // Unexpected finalizer errors cannot leave a live Electron process behind.
        noteFatal(error);
        try {
          persistProbeReceipt(
            output,
            serializeProbeReceipt(
              receipt,
              "partial",
              { status: "failed", errors: [errorText(error)] },
              1,
            ),
          );
        } catch (writeError) {
          process.stderr.write(`Emergency receipt persistence failed: ${errorText(writeError)}\n`);
        }
        app.exit(1);
      });
    return finishPromise;
  }
  try {
    if (process.versions.electron !== expectedElectron)
      throw new Error(`Expected Electron ${expectedElectron}`);
    for (const name of [
      "manifest.json",
      "background.js",
      "content.js",
      "popup.html",
      "login.html",
      "frame.html",
    ]) {
      const bytes = await NodeFSP.readFile(NodePath.join(fixtureDirectory, name));
      receipt.fixtureHashes[name] = hash(bytes);
      assets[name] = bytes.toString();
    }
    const handler = async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (
        url.pathname === "/report" &&
        request.method === "POST" &&
        url.searchParams.get("run") === runToken
      ) {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 65536) {
            response.writeHead(413).end();
            return;
          }
        }
        try {
          record(JSON.parse(body));
        } catch {
          response.writeHead(400).end();
          return;
        }
        const origin = request.headers.origin;
        if (origins.includes(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
        response.writeHead(200).end("ok");
        return;
      }
      if (url.pathname === "/redirect") {
        response.writeHead(302, { Location: "/login?phase=redirected" }).end();
        return;
      }
      const file =
        url.pathname === "/frame" ? "frame.html" : url.pathname === "/login" ? "login.html" : null;
      if (!file) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(assets[file].replaceAll("__FRAME_ORIGIN__", origins[1]));
    };
    for (let index = 0; index < 2; index++) {
      const server = NodeHttp.createServer((request, response) => {
        void handler(request, response).catch(() => response.destroy());
      });
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      origins.push(`http://127.0.0.1:${server.address().port}`);
    }
    const extensionPath = NodePath.join(temporary, "extension");
    await NodeFSP.mkdir(extensionPath);
    for (const name of ["manifest.json", "background.js", "content.js", "popup.html"]) {
      await NodeFSP.writeFile(
        NodePath.join(extensionPath, name),
        assets[name].replaceAll("__REPORT_ORIGIN__/report", `${origins[0]}/report?run=${runToken}`),
      );
    }
    await app.whenReady();
    const createSession = (partition) => {
      const browserSession = session.fromPartition(partition);
      ownedSessions.push(browserSession);
      browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.webRequest.onBeforeRequest((details, callback) => {
        const permitted =
          origins.some((origin) => details.url.startsWith(`${origin}/`)) ||
          details.url.startsWith("chrome-extension://") ||
          details.url === "about:blank";
        if (!permitted) receipt.externalRequests.push({ url: details.url, blocked: true });
        callback({ cancel: !permitted });
      });
      return browserSession;
    };
    const profiles = {};
    for (const name of ["A", "B"]) {
      receipt.stage = `profile-${name}`;
      const partition = `persist:morrowbyte-proton-probe-${runToken}-${name}`;
      const browserSession = createSession(partition);
      const extension = await deadline(
        browserSession.extensions.loadExtension(extensionPath, { allowFileAccess: false }),
        "load MV3",
      );
      const popup = new BrowserWindow({
        show: false,
        webPreferences: {
          session: browserSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      windows.push(popup);
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      await deadline(popup.loadURL(`chrome-extension://${extension.id}/popup.html`), "load popup");
      const command = (message) =>
        deadline(
          popup.webContents.executeJavaScript(
            `chrome.runtime.sendMessage(${JSON.stringify(message)})`,
          ),
          `worker ${message.type}`,
          45000,
        );
      const base = await command({ type: "base-probe" });
      if (!base?.outcomes) throw new Error(`Profile ${name}: worker did not answer`);
      receipt.apiProfiles[name] = base.outcomes;
      receipt.invariants.popupSameSession =
        (receipt.invariants.popupSameSession ?? true) &&
        popup.webContents.session === browserSession;
      await waitFor(
        () =>
          events.some(
            (event) => event.type === "worker-boot" && event.workerNonce === base.workerNonce,
          ),
        `worker boot ${name}`,
      );
      const running = Object.values(browserSession.serviceWorkers.getAllRunning()).some(
        (worker) => worker.scope === extension.url,
      );
      receipt.invariants.workerBoot =
        (receipt.invariants.workerBoot ?? true) &&
        running &&
        events.some(
          (event) => event.type === "worker-boot" && event.workerNonce === base.workerNonce,
        );
      const before = await command({ type: "profile-get" });
      await command({ type: "profile-set", marker: name });
      profiles[name] = {
        partition,
        browserSession,
        extension,
        popup,
        command,
        workerNonce: base.workerNonce,
        before,
      };
    }
    const markerA = await profiles.A.command({ type: "profile-get" });
    const markerB = await profiles.B.command({ type: "profile-get" });
    receipt.invariants.profileIsolation =
      profiles.A.extension.id === profiles.B.extension.id &&
      profiles.A.workerNonce !== profiles.B.workerNonce &&
      profiles.B.before.marker === null &&
      markerA.marker === "A" &&
      markerB.marker === "B";
    receipt.stage = "incognito-boundary";
    const ephemeral = createSession(`morrowbyte-proton-probe-${runToken}-incognito`);
    try {
      await ephemeral.extensions.loadExtension(extensionPath);
      receipt.incognito = { status: "supported", error: null };
      receipt.invariants.incognitoRejected = false;
    } catch (error) {
      receipt.incognito = { status: "unsupported", error: errorText(error) };
      receipt.invariants.incognitoRejected = /persistent|in.memory/i.test(String(error));
    }
    receipt.stage = "native-webview-host";
    const host = new BrowserWindow({
      show: true,
      width: 1000,
      height: 700,
      webPreferences: {
        webviewTag: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    windows.push(host);
    host.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    host.webContents.on("will-attach-webview", (event, preferences, parameters) => {
      if (![profiles.A.partition, profiles.B.partition].includes(parameters.partition)) {
        event.preventDefault();
        return;
      }
      preferences.sandbox = true;
      preferences.contextIsolation = false;
      preferences.nodeIntegration = false;
      preferences.nodeIntegrationInSubFrames = false;
    });
    await host.loadURL("data:text/html,<title>Owned compatibility host</title><body></body>");
    const createGuest = async (name, profile) => {
      receipt.stage = `guest-${name}`;
      const url = `${origins[0]}/login?guest=${name}`;
      const id = await deadline(
        host.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const guest = document.createElement('webview'); guest.id = ${JSON.stringify(name)};
        guest.setAttribute('partition', ${JSON.stringify(profile.partition)});
        guest.style.cssText = 'width:300px;height:400px;display:inline-flex';
        guest.addEventListener('did-stop-loading', () => resolve(guest.getWebContentsId()), {once:true});
        guest.addEventListener('did-fail-load', event => reject(new Error(event.errorDescription)), {once:true});
        guest.src = ${JSON.stringify(url)}; document.body.appendChild(guest);
      })`),
        `create guest ${name}`,
      );
      const guest = webContents.fromId(id);
      if (!guest || guest.session !== profile.browserSession || guest.getType() !== "webview")
        throw new Error("Expected actual profile-bound webview guest");
      guest.on("focus", () => record({ type: "native-focus", tabId: guest.id }));
      guest.on("blur", () => record({ type: "native-blur", tabId: guest.id }));
      return { name, profile, guest };
    };
    const alpha = await createGuest("alpha", profiles.A);
    const beta = await createGuest("beta", profiles.A);
    const other = await createGuest("other", profiles.B);
    const nativeFrames = (guest) =>
      guest.mainFrame.framesInSubtree.map((frame) => ({
        url: frame.url,
        main: frame === guest.mainFrame,
        frameTreeNodeId: frame.frameTreeNodeId,
        routingId: frame.routingId,
        processId: frame.processId,
      }));
    const capture = async (entry, requestId) => {
      receipt.stage = `capture-${requestId}`;
      const frames = nativeFrames(entry.guest);
      await Promise.all(
        entry.guest.mainFrame.framesInSubtree.map((frame) =>
          frame.executeJavaScript(
            `window.postMessage({type:'morrowbyte-probe', requestId:${JSON.stringify(requestId)}}, location.origin)`,
          ),
        ),
      );
      await waitFor(
        () =>
          events.filter((event) => event.type === "content" && event.requestId === requestId)
            .length >= frames.length,
        `content frames ${requestId}`,
      );
      const observations = events.filter(
        (event) => event.type === "content" && event.requestId === requestId,
      );
      const mappings = observations.map((observation) =>
        classifyContentMapping(observation, { tabId: entry.guest.id, frames }),
      );
      receipt.mappings.push({
        name: requestId,
        nativeTabId: entry.guest.id,
        nativeFrames: frames,
        mappings,
      });
      return { observations, mappings, frames };
    };
    const first = await capture(alpha, "alpha-before");
    const second = await capture(beta, "beta-before");
    const third = await capture(other, "other-before");
    receipt.invariants.mainFrameMapping = [first, second, third].every((entry) =>
      entry.mappings.some(
        (mapping) => mapping.expected?.frameId === 0 && mapping.status === "supported",
      ),
    );
    receipt.invariants.subframeMapping = [first, second, third].every(
      (entry) =>
        entry.frames.length >= 3 &&
        entry.mappings.length === entry.frames.length &&
        entry.mappings.every((mapping) => mapping.status === "supported"),
    );
    receipt.invariants.tabSeparation =
      first.observations.every((entry) => entry.workerNonce === profiles.A.workerNonce) &&
      second.observations.every((entry) => entry.workerNonce === profiles.A.workerNonce) &&
      third.observations.every((entry) => entry.workerNonce === profiles.B.workerNonce) &&
      alpha.guest.id !== beta.guest.id;
    receipt.tabApis = await profiles.A.command({ type: "tab-probe", tabId: alpha.guest.id });
    receipt.focus = [];
    for (const active of [alpha, beta]) {
      active.guest.focus();
      await waitFor(() => active.guest.isFocused(), `focus ${active.name}`);
      const result = await profiles.A.command({ type: "tab-probe", tabId: active.guest.id });
      const nativeFocused = [alpha, beta]
        .filter((entry) => entry.guest.isFocused())
        .map((entry) => entry.guest.id);
      const extensionFocused = result["tabs.query.active"]?.evidence?.map((tab) => tab.id) ?? [];
      receipt.focus.push({
        name: active.name,
        nativeFocused,
        extensionFocused,
        status: result["tabs.query.active"]?.status ?? "unknown",
      });
    }
    receipt.invariants.focusMapping = receipt.focus.every(
      (entry) =>
        entry.status === "supported" &&
        entry.nativeFocused.length === 1 &&
        entry.extensionFocused.length === 1 &&
        entry.nativeFocused[0] === entry.extensionFocused[0],
    );
    await deadline(alpha.guest.loadURL(`${origins[0]}/redirect`), "redirect owned guest");
    const redirected = await capture(alpha, "alpha-after-redirect");
    receipt.invariants.redirectMapping =
      redirected.mappings.length >= 3 &&
      redirected.mappings.every((entry) => entry.status === "supported") &&
      alpha.guest.getURL() === `${origins[0]}/login?phase=redirected`;
    receipt.createTab = await profiles.A.command({
      type: "create-tab",
      url: `${origins[0]}/login?guest=extension-created`,
    });
    const profileBTabs = await profiles.B.command({ type: "tab-probe", tabId: alpha.guest.id });
    receipt.crossProfileTabAccess = profileBTabs["tabs.get"];
    receipt.invariants.profileIsolation &&= profileBTabs["tabs.get"]?.status === "unsupported";
    receipt.extensionEvents = await profiles.A.command({ type: "events" });
    receipt.failures = receiptFailures(receipt);
    exitCode = receipt.failures.length === 0 ? 0 : 1;
  } catch (error) {
    noteFatal(error);
  } finally {
    await finish(exitCode);
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  void runProbe().catch((error) => {
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
