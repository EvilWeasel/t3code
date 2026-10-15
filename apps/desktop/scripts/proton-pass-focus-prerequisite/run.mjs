/** Integration-only credential-free focus launcher. Does not install, build, start a backend, or inherit credentials. */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";

let capturedPid = null;
let capturedTemporary = null;
async function launch() {
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
    process.env.MORROWBYTE_FOCUS_PREREQUISITE !== "1" ||
    process.env.MORROWBYTE_RUNNER_PROFILE !== "blacksmith-8vcpu-ubuntu-2404"
  )
    throw new Error(
      "Explicit Blacksmith focus job and non-root Linux required (workflow attestation external)",
    );
  const runnerTemp = NodeFS.realpathSync(process.env.RUNNER_TEMP ?? "");
  for (const key of ["--entry", "--output"])
    if (!options[key].startsWith(`${runnerTemp}/`))
      throw new Error("Entry and artifacts must be under RUNNER_TEMP");
  if (!/^:\d+(?:\.\d+)?$/.test(process.env.DISPLAY ?? "") || !process.env.XAUTHORITY)
    throw new Error("Private xvfb-run display required");
  const display = process.env.DISPLAY.split(".")[0];
  const wrapperPid = process.ppid;
  const wrapperCommand = NodeFS.readFileSync(`/proc/${wrapperPid}/cmdline`, "utf8")
    .split("\0")
    .filter(Boolean);
  const wrapperDirectory = NodeFS.realpathSync(`/proc/${wrapperPid}/cwd`);
  const xvfbRun = NodeFS.realpathSync("/usr/bin/xvfb-run");
  const resolveArgument = (argument) => {
    try {
      return NodeFS.realpathSync(NodePath.resolve(wrapperDirectory, argument));
    } catch {
      return null;
    }
  };
  if (
    NodeFS.statSync(`/proc/${wrapperPid}`).uid !== process.getuid() ||
    !wrapperCommand.some((argument) => resolveArgument(argument) === xvfbRun) ||
    !wrapperCommand.includes("--auto-servernum") ||
    wrapperCommand.some((argument) => argument === "-f" || argument.startsWith("--auth-file")) ||
    !wrapperCommand.some(
      (argument) =>
        resolveArgument(argument) === NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url)),
    ) ||
    !Object.entries(options).every(([key, value]) => {
      const at = wrapperCommand.indexOf(key);
      return at !== -1 && wrapperCommand[at + 1] === value;
    })
  )
    throw new Error("This invocation must be a direct child of its own xvfb-run");
  const authority = NodeFS.realpathSync(process.env.XAUTHORITY);
  const authStat = NodeFS.statSync(authority);
  const authDirectory = NodeFS.statSync(NodePath.dirname(authority));
  if (
    !authStat.isFile() ||
    authStat.uid !== process.getuid() ||
    (authStat.mode & 0o077) !== 0 ||
    authDirectory.uid !== process.getuid() ||
    (authDirectory.mode & 0o077) !== 0
  )
    throw new Error("Private invocation-owned Xauthority required");
  const candidates = [];
  for (const pid of NodeFS.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    try {
      const command = NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (NodePath.basename(command[0] ?? "") !== "Xvfb" || !command.includes(display)) continue;
      if (NodeFS.statSync(`/proc/${pid}`).uid !== process.getuid())
        throw new Error("Ambiguous display owner");
      const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      candidates.push({ pid: Number(pid), parent: Number(fields[1]), command });
    } catch (error) {
      if (error instanceof Error && error.message === "Ambiguous display owner") throw error;
      // Exiting processes cannot qualify; no fallback to an ambient display.
    }
  }
  if (candidates.length !== 1 || candidates[0].parent !== wrapperPid)
    throw new Error("Unique sibling Xvfb from this xvfb-run required");
  const ownedXvfb = candidates[0];
  const authIndex = ownedXvfb.command.indexOf("-auth");
  if (authIndex < 0 || resolveArgument(ownedXvfb.command[authIndex + 1]) !== authority)
    throw new Error("Xvfb auth does not match this invocation");
  const xvfbPid = ownedXvfb.pid;
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
  if (
    NodePath.basename(output) !== "proton-pass-focus-prerequisite" ||
    NodePath.basename(options["--entry"]) !== "main.cjs"
  )
    throw new Error("Separate focus output directory and main.cjs required");
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
    scope: "FOCUS_PREREQUISITE_ONLY",
    autofill: "NOT_EXERCISED",
    assertedRunnerProfile: process.env.MORROWBYTE_RUNNER_PROFILE,
    runnerAttestation: "CALLER_ASSERTION_ONLY_REQUIRES_INTEGRATION_WORKFLOW_JOB_EVIDENCE",
    executable,
    executableSha256: hash(NodeFS.readFileSync(executable)),
    expectedElectron: "44.4.5",
    entrySha256: hash(NodeFS.readFileSync(options["--entry"])),
    xvfbPid,
    xvfbRunPid: wrapperPid,
    xvfbRunSha256: hash(NodeFS.readFileSync(xvfbRun)),
    privateDisplayBound: true,
    xdotoolSha256: hash(NodeFS.readFileSync(xdotool)),
  };
  const temporary = NodeFS.mkdtempSync(NodePath.join(runnerTemp, "morrowbyte-focus-"));
  capturedTemporary = temporary;
  NodeFS.writeFileSync(NodePath.join(temporary, ".owned"), "synthetic-focus-only", {
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
    MORROWBYTE_FOCUS_PREREQUISITE: "1",
    MORROWBYTE_RUNNER_PROFILE: binding.assertedRunnerProfile,
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
  capturedPid = child.pid ?? null;
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
    fixture = JSON.parse(
      NodeFS.readFileSync(NodePath.join(output, "fixture-receipt.json"), "utf8"),
    );
  } catch {
    /* Missing final receipt is failure even for child exit 0. */
  }
  const passed =
    exitCode === 0 &&
    !signal &&
    !timedOut &&
    temporaryRemoved &&
    !cleanupTimedOut &&
    fixture?.scope === "FOCUS_PREREQUISITE_ONLY" &&
    fixture?.autofill === "NOT_EXERCISED" &&
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
        integrationWorkflowJobEvidenceRequired: true,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  process.exit(passed ? 0 : 1);
}
void launch().catch(async () => {
  if (capturedPid !== null) {
    try {
      process.kill(-capturedPid, "SIGKILL");
    } catch {
      /* Captured child already exited. */
    }
  }
  let deadline;
  try {
    if (capturedTemporary !== null)
      await Promise.race([
        NodeFSP.rm(capturedTemporary, { recursive: true, force: true }),
        new Promise((resolve) => {
          deadline = setTimeout(resolve, 8000);
        }),
      ]);
  } catch {
    /* Failure remains exit 1; no raw error output. */
  } finally {
    clearTimeout(deadline);
  }
  process.stderr.write("Focus prerequisite wrapper failed\n");
  process.exit(1);
});
