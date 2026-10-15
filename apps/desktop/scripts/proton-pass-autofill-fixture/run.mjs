/** Integration-only launcher. Does not install, build, start a backend, or inherit credentials. */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";

const hash = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (
    !["--electron", "--entry", "--output"].includes(key) ||
    options[key] ||
    !value ||
    !NodePath.isAbsolute(value)
  )
    throw new Error("Invalid fixture arguments");
  options[key] = NodePath.resolve(value);
}
if (Object.keys(options).length !== 3)
  throw new Error("Require --electron --entry --output absolute paths");
if (
  process.platform !== "linux" ||
  process.getuid?.() === 0 ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.MORROWBYTE_NAMESPACE_PROBE !== "1" ||
  process.env.MORROWBYTE_NAMESPACE_PROFILE !== "namespace-profile-ci-builder"
)
  throw new Error("Namespace non-root Actions runner required");
const runnerTemp = NodeFS.realpathSync(process.env.RUNNER_TEMP ?? "");
for (const key of ["--entry", "--output"])
  if (!options[key].startsWith(`${runnerTemp}/`))
    throw new Error("Entry and artifacts must be under RUNNER_TEMP");
if (!/^:\d+(?:\.\d+)?$/.test(process.env.DISPLAY ?? "") || !process.env.XAUTHORITY)
  throw new Error("Private xvfb-run display required");
const display = process.env.DISPLAY.split(".")[0];
let xvfbPid;
for (const pid of NodeFS.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
  try {
    const command = NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    if (
      NodePath.basename(command[0] ?? "") === "Xvfb" &&
      command.includes(display) &&
      NodeFS.statSync(`/proc/${pid}`).uid === process.getuid()
    )
      xvfbPid = Number(pid);
  } catch {
    /* A process may exit during this read-only ownership check. */
  }
}
if (!xvfbPid) throw new Error("Owned Xvfb process identity unavailable");
const xdotool = NodeFS.realpathSync("/usr/bin/xdotool");
const repo = NodeFS.realpathSync(NodeURL.fileURLToPath(new URL("../../../../", import.meta.url)));
const git = NodeChildProcess.execFileSync("/usr/bin/git", ["-C", repo, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (
  !/^[a-f0-9]{40}$/.test(git) ||
  process.env.GITHUB_SHA !== git ||
  !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
)
  throw new Error("Source/run identity mismatch");
const output = options["--output"];
NodeFS.mkdirSync(output, { recursive: true, mode: 0o700 });
if (
  !NodeFS.realpathSync(output).startsWith(`${runnerTemp}/`) ||
  !NodeFS.realpathSync(options["--entry"]).startsWith(`${runnerTemp}/`)
)
  throw new Error("Resolved artifact/entry escapes RUNNER_TEMP");
if (NodeFS.readdirSync(output).length) throw new Error("Artifact directory must be empty");
const executable = NodeFS.realpathSync(options["--electron"]);
const binding = {
  runnerName: process.env.RUNNER_NAME ?? "",
  job: process.env.GITHUB_JOB ?? "",
  source: git,
  lockSha256: hash(NodeFS.readFileSync(NodePath.join(repo, "pnpm-lock.yaml"))),
  runId: process.env.GITHUB_RUN_ID,
  namespaceProfile: process.env.MORROWBYTE_NAMESPACE_PROFILE,
  executable,
  executableSha256: hash(NodeFS.readFileSync(executable)),
  expectedElectron: "44.4.5",
  entrySha256: hash(NodeFS.readFileSync(options["--entry"])),
  xvfbPid,
  xdotoolSha256: hash(NodeFS.readFileSync(xdotool)),
};
const temporary = NodeFS.mkdtempSync(NodePath.join(runnerTemp, "morrowbyte-autofill-"));
NodeFS.writeFileSync(NodePath.join(temporary, ".owned"), "synthetic-autofill-only", {
  mode: 0o600,
});
for (const name of ["home", "user-data", "session-data", "runtime"])
  NodeFS.mkdirSync(NodePath.join(temporary, name), { mode: 0o700 });
const bindingFile = NodePath.join(temporary, "binding.json");
NodeFS.writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
// Only these current checkout dependency roots may resolve native externals from the temporary bundle.
const nodePath = [
  NodePath.join(repo, "apps/desktop/node_modules"),
  NodePath.join(repo, "node_modules"),
].join(NodePath.delimiter);
const environment = {
  PATH: "/usr/bin:/bin",
  HOME: NodePath.join(temporary, "home"),
  XDG_RUNTIME_DIR: NodePath.join(temporary, "runtime"),
  TMPDIR: temporary,
  DISPLAY: process.env.DISPLAY,
  XAUTHORITY: process.env.XAUTHORITY,
  NODE_PATH: nodePath,
  LANG: "C.UTF-8",
  GITHUB_ACTIONS: "true",
  GITHUB_SHA: git,
  GITHUB_RUN_ID: binding.runId,
  MORROWBYTE_NAMESPACE_PROBE: "1",
  MORROWBYTE_NAMESPACE_PROFILE: binding.namespaceProfile,
};
let rawBytes = 0;
let timedOut = false;
let exitCode = null;
let signal = null;
let temporaryRemoved = false;
const log = NodeFS.openSync(NodePath.join(output, "electron.log"), "wx", 0o600);
const child = NodeChildProcess.spawn(
  executable,
  [
    options["--entry"],
    "--output",
    output,
    "--temporary",
    temporary,
    "--binding",
    bindingFile,
    "--repo",
    repo,
  ],
  {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
// Raw Chromium/page errors may contain content: retain counts only, never their bytes.
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    rawBytes += chunk.length;
  });
const timer = setTimeout(() => {
  timedOut = true;
  if (child.pid) process.kill(-child.pid, "SIGKILL");
}, 150000);
await new Promise((resolve) => {
  child.once("error", () => resolve());
  child.once("close", (code, childSignal) => {
    exitCode = code;
    signal = childSignal;
    resolve();
  });
});
clearTimeout(timer);
// Captured child process group only; never find or kill by process-name matching.
if (child.pid) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* Already exited. */
  }
}
let cleanupTimedOut = false;
let cleanupTimer;
try {
  await Promise.race([
    NodeFSP.rm(temporary, { recursive: true, force: true }).then(() => {
      temporaryRemoved = !NodeFS.existsSync(temporary);
    }),
    new Promise((resolve) => {
      cleanupTimer = setTimeout(() => {
        cleanupTimedOut = true;
        resolve();
      }, 8000);
    }),
  ]);
} catch {
  temporaryRemoved = false;
} finally {
  clearTimeout(cleanupTimer);
}
let fixture = null;
try {
  fixture = JSON.parse(NodeFS.readFileSync(NodePath.join(output, "fixture-receipt.json"), "utf8"));
} catch {
  /* Missing final receipt is failure even for child exit 0. */
}
const passed =
  exitCode === 0 &&
  !signal &&
  !timedOut &&
  temporaryRemoved &&
  !cleanupTimedOut &&
  fixture?.passed === true &&
  fixture?.phase === "final" &&
  fixture?.runtime?.electron === "44.4.5" &&
  fixture?.runtime?.executable === executable &&
  fixture?.runtime?.sha256 === binding.executableSha256 &&
  fixture?.binding?.source === git &&
  fixture?.binding?.lockSha256 === binding.lockSha256 &&
  fixture?.binding?.runId === binding.runId &&
  fixture?.binding?.entrySha256 === binding.entrySha256;
NodeFS.writeSync(
  log,
  JSON.stringify({
    sanitized: true,
    discardedRawBytes: rawBytes,
    childExitCode: exitCode,
    signal,
    timedOut,
  }) + "\n",
);
NodeFS.closeSync(log);
NodeFS.writeFileSync(
  NodePath.join(output, "runner-receipt.json"),
  JSON.stringify(
    {
      ...binding,
      passed,
      exitCode,
      signal,
      timedOut,
      temporaryRemoved,
      cleanupTimedOut,
      rawOutputDiscarded: true,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
process.exit(passed ? 0 : 1);
