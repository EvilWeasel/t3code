/** Integration-only wrapper: builds the real Manager fixture and observes native HTTP independently. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHTTP from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.MORROWBYTE_CI_PROBE !== "1") {
  throw new Error("Integration-owned CI execution only; do not launch on a workstation");
}
const argument = (name) => {
  const index = process.argv.indexOf(name);
  NodeAssert.ok(index >= 0 && process.argv[index + 1], `Missing ${name}`);
  return process.argv[index + 1];
};
const electron = await NodeFSP.realpath(argument("--electron"));
const output = NodePath.resolve(argument("--output"));
const desktop = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const root = NodePath.resolve(desktop, "../..");
const expectedElectron = JSON.parse(
  await NodeFSP.readFile(NodePath.join(desktop, "package.json"), "utf8"),
).dependencies.electron;
NodeAssert.match(expectedElectron, /^\d+\.\d+\.\d+$/u);
NodeAssert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/u);
NodeAssert.equal(process.env.GITHUB_REPOSITORY, "morrowbyte/t3code");
const hash = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "morrowbyte-native-post-"));
for (const directory of ["user-data", "session-data", "home", "downloads", "artifacts", "bundle"]) {
  await NodeFSP.mkdir(NodePath.join(temporary, directory));
}
await NodeFSP.writeFile(NodePath.join(temporary, ".owned-probe"), "synthetic-only");
await NodeFSP.mkdir(output, { recursive: true });
const receipt = {
  version: 1,
  status: "running",
  stage: "prepare",
  transportStatus: "running",
  profileCleanup: "pending",
  failureCodes: [],
  scope:
    "Synthetic loopback native production Manager POST transport only; no site/login/installed-client proof",
  sourceSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID ?? null,
  expectedElectron,
  executableSha256: hash(await NodeFSP.readFile(electron)),
  sourceHashes: {},
  requests: [],
  violations: [],
  childExit: null,
};
function persist(status, stage) {
  receipt.status = status;
  receipt.stage = stage;
  const name = status === "running" ? "runner-receipt.partial.json" : "runner-receipt.json";
  const destination = NodePath.join(output, name);
  const fd = NodeFS.openSync(`${destination}.tmp`, "w");
  try {
    NodeFS.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
  NodeFS.renameSync(`${destination}.tmp`, destination);
  const directory = NodeFS.openSync(output, "r");
  try {
    NodeFS.fsyncSync(directory);
  } finally {
    NodeFS.closeSync(directory);
  }
}
const fields =
  "<input name='result' value='fixture value'><input name='marker' value='synthetic-only'>";
// This case explicitly opts into an opener. Default _blank noopener behavior is not overridden.
const openerScript = `<script>
  addEventListener('message', event => {
    if (event.origin !== location.origin || !['native-post-encoded','native-post-multipart'].includes(event.data)) return;
    if (!event.source || event.source === window) return;
    event.source.postMessage(event.data + ':ack', location.origin);
  });
</script>`;
const server = NodeHTTP.createServer((request, response) => {
  const fail = (reason) => {
    receipt.violations.push(reason);
    persist("running", "http-rejected");
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("fixture rejected");
  };
  const path = request.url;
  if (request.method === "GET" && path === "/host") {
    response.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'; script-src 'self'; object-src 'none'",
    });
    response.end("<!doctype html><body></body>");
    return;
  }
  if (request.method === "GET" && path === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  const form = /^\/form\/(encoded|multipart)$/u.exec(path ?? "");
  if (request.method === "GET" && form) {
    const kind = form[1];
    const enctype =
      kind === "encoded" ? "application/x-www-form-urlencoded" : "multipart/form-data";
    response.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy":
        "default-src 'none'; form-action 'self'; script-src 'unsafe-inline'",
    });
    response.end(
      `<!doctype html><form action='/return/${kind}' method='post' target='_blank' rel='opener' enctype='${enctype}'>${fields}</form>${openerScript}`,
    );
    return;
  }
  const returned = /^\/return\/(encoded|multipart)$/u.exec(path ?? "");
  if (request.method !== "POST" || !returned) {
    fail("unexpected-route-or-method");
    return;
  }
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > 4096) {
      request.destroy();
      receipt.violations.push("body-budget");
      return;
    }
    chunks.push(chunk);
  });
  request.on("error", () => {
    receipt.violations.push("request-error");
  });
  request.on("end", () => {
    try {
      const kind = returned[1];
      NodeAssert.equal(
        receipt.requests.some((entry) => entry.kind === kind),
        false,
        "One canonical POST per case",
      );
      const body = Buffer.concat(chunks);
      const contentType = request.headers["content-type"] ?? "";
      NodeAssert.equal(request.headers.cookie, "native_post_fixture=synthetic-only");
      NodeAssert.equal(request.headers.referer, `${origin}/form/${kind}`);
      if (kind === "encoded") {
        NodeAssert.equal(contentType, "application/x-www-form-urlencoded");
        NodeAssert.deepEqual(body, Buffer.from("result=fixture+value&marker=synthetic-only"));
      } else {
        const boundary = /^multipart\/form-data; boundary=([A-Za-z0-9'()+_,.\/:=?-]{1,100})$/u.exec(
          contentType,
        )?.[1];
        NodeAssert.ok(boundary, "Native multipart boundary present");
        const expected = `--${boundary}\r\nContent-Disposition: form-data; name="result"\r\n\r\nfixture value\r\n--${boundary}\r\nContent-Disposition: form-data; name="marker"\r\n\r\nsynthetic-only\r\n--${boundary}--\r\n`;
        NodeAssert.deepEqual(
          body,
          Buffer.from(expected),
          "Exact native multipart bytes including closing boundary",
        );
      }
      receipt.requests.push({
        kind,
        method: request.method,
        bytes: body.length,
        sha256: hash(body),
        contentType,
        syntheticCookie: true,
        referrerPreserved: true,
      });
      persist("running", `${kind}-http-verified`);
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'none'",
      });
      response.end("<!doctype html><title>Synthetic POST return</title>");
    } catch {
      fail("post-bytes-or-metadata-mismatch");
    }
  });
});
let origin;
let child;
let timer;
let escalation;
let interrupted = false;
let log;
let failureCode = "fixture-prepare-failed";
function recordFailure(code) {
  receipt.failureCodes.push(code);
  process.exitCode = 1;
  persist("failed", code);
}
const stopChild = (reason) => {
  if (interrupted) return;
  interrupted = true;
  process.exitCode = 1;
  // Parent receipt precedes signal; child also flushes its own failure before destroying windows.
  recordFailure(reason);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    escalation = setTimeout(() => {
      recordFailure(`${reason}-forced-exit`);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000);
  }
};
process.once("SIGTERM", () => stopChild("runner-termination"));
process.once("SIGINT", () => stopChild("runner-interruption"));
try {
  failureCode = "fixture-bundle-failed";
  persist("running", "bundle");
  for (const relative of [
    "apps/desktop/src/preview/Manager.ts",
    "apps/desktop/src/preview/BrowserSession.ts",
    "apps/desktop/src/preview/WebviewPreferences.ts",
    "apps/desktop/src/preview/DesktopBrowserHost.ts",
    "apps/desktop/vite.config.ts",
    "scripts/lib/desktop-external-packages.ts",
    "apps/desktop/src/preview/fixtures/browser-native-post.ts",
    "apps/desktop/scripts/browser-native-post.test.mjs",
  ])
    receipt.sourceHashes[relative] = hash(await NodeFSP.readFile(NodePath.join(root, relative)));
  // Same main-process bundle recipe, isolated output, and no onSuccess/dev startup.
  const { build } = await import("vite-plus/pack");
  // The canonical config reads these files; a synthetic CI fixture must never resolve them.
  for (const name of [".env", ".env.local"]) {
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(root, name)),
      false,
      "No repo env files in fixture checkout",
    );
  }
  const { default: desktopConfig } = await import("../vite.config.ts");
  const main = desktopConfig.pack.find((entry) => entry.entry?.includes("src/main.ts"));
  NodeAssert.ok(main, "Canonical main-process pack configuration exists");
  await build({
    ...main,
    config: false,
    cwd: desktop,
    clean: false,
    onSuccess: undefined,
    entry: ["src/preview/fixtures/browser-native-post.ts"],
    outDir: NodePath.join(temporary, "bundle"),
    logLevel: "silent",
  });
  NodeAssert.equal(interrupted, false, "Stopped during fixture build");
  const bundle = NodePath.join(temporary, "bundle/browser-native-post.cjs");
  receipt.bundleSha256 = hash(await NodeFSP.readFile(bundle));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  NodeAssert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  const env = Object.fromEntries(
    [
      "PATH",
      "DISPLAY",
      "XAUTHORITY",
      "LD_LIBRARY_PATH",
      "XDG_RUNTIME_DIR",
      "LANG",
      "LC_ALL",
      "GITHUB_ACTIONS",
      "GITHUB_REPOSITORY",
      "GITHUB_SHA",
      "GITHUB_RUN_ID",
      "GITHUB_JOB",
      "RUNNER_NAME",
      "MORROWBYTE_CI_PROBE",
    ].flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
  Object.assign(env, {
    HOME: NodePath.join(temporary, "home"),
    XDG_CONFIG_HOME: NodePath.join(temporary, "home/.config"),
    XDG_CACHE_HOME: NodePath.join(temporary, "home/.cache"),
    XDG_DATA_HOME: NodePath.join(temporary, "home/.local/share"),
    MORROWBYTE_NATIVE_POST_TEMP: temporary,
    MORROWBYTE_NATIVE_POST_OUTPUT: output,
    MORROWBYTE_NATIVE_POST_ORIGIN: origin,
  });
  failureCode = "electron-spawn-or-exit-failed";
  log = await NodeFSP.open(NodePath.join(output, "electron.log"), "w");
  persist("running", "electron");
  NodeAssert.equal(interrupted, false, "Stopped before Electron launch");
  child = NodeChildProcess.spawn(electron, [bundle], { env, stdio: ["ignore", log.fd, log.fd] });
  receipt.childExit = await new Promise((resolve, reject) => {
    timer = setTimeout(() => stopChild("runner-watchdog"), 110000);
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  NodeAssert.equal(interrupted, false);
  NodeAssert.deepEqual(receipt.childExit, { code: 0, signal: null });
  failureCode = "native-receipt-invalid";
  const native = JSON.parse(
    await NodeFSP.readFile(NodePath.join(output, "fixture-receipt.json"), "utf8"),
  );
  NodeAssert.equal(native.status, "passed");
  failureCode = "native-runtime-or-source-mismatch";
  NodeAssert.equal(native.sourceSha, process.env.GITHUB_SHA);
  NodeAssert.equal(native.electron, expectedElectron);
  NodeAssert.equal(native.executableSha256, receipt.executableSha256);
  failureCode = "native-case-evidence-invalid";
  NodeAssert.equal(native.failureCode, null);
  NodeAssert.equal(native.blockedRequests, 0);
  NodeAssert.equal(native.unexpectedNavigation, 0);
  NodeAssert.equal(native.openLinks, 0);
  NodeAssert.deepEqual(
    native.cases.map((entry) => entry.kind),
    ["encoded", "multipart"],
  );
  for (const entry of native.cases) {
    for (const key of [
      "nativeWebview",
      "openerPreserved",
      "sameSession",
      "contextIsolation",
      "sandbox",
    ])
      NodeAssert.equal(entry[key], true);
    NodeAssert.equal(entry.nodeIntegration, false);
    NodeAssert.equal(entry.openerPolicy, "explicit-rel-opener");
  }
  failureCode = "http-evidence-invalid";
  NodeAssert.deepEqual(
    receipt.requests.map((entry) => entry.kind),
    ["encoded", "multipart"],
  );
  NodeAssert.deepEqual(receipt.violations, []);
  receipt.transportStatus = "passed";
  // Transport evidence is complete; overall success still waits for owned-profile cleanup.
  persist("running", "transport-verified");
} catch {
  if (receipt.transportStatus !== "passed") receipt.transportStatus = "failed";
  recordFailure(failureCode);
} finally {
  clearTimeout(timer);
  clearTimeout(escalation);
  if (child && child.exitCode === null && child.signalCode === null)
    stopChild("runner-finalization");
  try {
    server.closeAllConnections();
    if (server.listening)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await log?.close();
  } catch {
    recordFailure("runner-resource-cleanup-failed");
  }
  // Cleanup is independent evidence: a transport pass never implies profile removal.
  if (receipt.transportStatus === "passed" && receipt.status !== "failed") {
    try {
      await NodeFSP.rm(temporary, { recursive: true, force: true });
      receipt.profileCleanup = "removed";
      persist("passed", "complete");
    } catch {
      receipt.profileCleanup = "failed";
      recordFailure("profile-cleanup-failed");
    }
  } else {
    receipt.profileCleanup = "retained-after-failure";
    persist("failed", receipt.stage);
  }
}
