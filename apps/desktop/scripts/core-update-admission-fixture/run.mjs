/** Integration-only CORE admission launcher. No installer, physical input or user state. */
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import * as URL from "node:url";
import * as Crypto from "node:crypto";
import * as CP from "node:child_process";

const sha = (bytes) => Crypto.createHash("sha256").update(bytes).digest("hex");
const fail = () => {
  throw new Error("Core admission prerequisite refused");
};
let childPid;
let temporary;
const killOwned = () => {
  if (childPid) {
    try {
      process.kill(-childPid, "SIGKILL");
    } catch {
      /* Owned group already exited. */
    }
  }
};
async function removeOwned() {
  if (!temporary) return false;
  let timer;
  try {
    return await Promise.race([
      FSP.rm(temporary, { recursive: true, force: true }).then(() => !FS.existsSync(temporary)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 8000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
async function launch() {
  const flags = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i],
      value = process.argv[i + 1];
    if (
      !["--electron", "--entry", "--output"].includes(key) ||
      flags.has(key) ||
      !value ||
      !Path.isAbsolute(value)
    )
      fail();
    flags.set(key, Path.resolve(value));
  }
  if (
    flags.size !== 3 ||
    process.platform !== "linux" ||
    process.getuid?.() === 0 ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.MORROWBYTE_CORE_UPDATE_ADMISSION !== "1" ||
    process.env.MORROWBYTE_RUNNER_PROFILE !== "blacksmith-8vcpu-ubuntu-2404"
  )
    fail();
  const root = FS.realpathSync(
    Path.resolve(Path.dirname(URL.fileURLToPath(import.meta.url)), "../../../.."),
  );
  const runnerTemp = FS.realpathSync(process.env.RUNNER_TEMP ?? "");
  const entry = FS.realpathSync(flags.get("--entry"));
  const output = flags.get("--output");
  if (
    Path.basename(entry) !== "main.cjs" ||
    Path.basename(Path.dirname(entry)) !== "core-update-admission-build" ||
    Path.basename(output) !== "core-update-admission-fixture" ||
    !entry.startsWith(runnerTemp + "/") ||
    Path.dirname(output) !== runnerTemp ||
    !/^:\d+(?:\.\d+)?$/.test(process.env.DISPLAY ?? "") ||
    !process.env.XAUTHORITY
  )
    fail();
  FS.mkdirSync(output, { recursive: true, mode: 0o700 });
  if (FS.realpathSync(output) !== output || FS.readdirSync(output).length !== 0) fail();
  // Prove this invocation's own xvfb-run, Xvfb and private auth path before Electron.
  const parentPid = process.ppid;
  const command = FS.readFileSync(`/proc/${parentPid}/cmdline`, "utf8").split("\0").filter(Boolean);
  const parentCwd = FS.realpathSync(`/proc/${parentPid}/cwd`);
  const resolve = (part) => {
    try {
      return FS.realpathSync(Path.resolve(parentCwd, part));
    } catch {
      return null;
    }
  };
  const xvfbRun = FS.realpathSync("/usr/bin/xvfb-run");
  if (
    FS.statSync(`/proc/${parentPid}`).uid !== process.getuid() ||
    !command.some((part) => resolve(part) === xvfbRun) ||
    !command.includes("--auto-servernum") ||
    command.some((part) => part === "-f" || part.startsWith("--auth-file")) ||
    !command.some(
      (part) => resolve(part) === FS.realpathSync(URL.fileURLToPath(import.meta.url)),
    ) ||
    ![...flags].every(
      ([key, value]) => command[command.indexOf(key) + 1] === value && command.indexOf(key) >= 0,
    )
  )
    fail();
  const authority = FS.realpathSync(process.env.XAUTHORITY);
  for (const filename of [authority, Path.dirname(authority)]) {
    const stat = FS.statSync(filename);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail();
  }
  if (!FS.statSync(authority).isFile()) fail();
  const display = process.env.DISPLAY.split(".")[0];
  const servers = [];
  for (const pid of FS.readdirSync("/proc").filter((value) => /^\d+$/.test(value))) {
    try {
      const args = FS.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (Path.basename(args[0] ?? "") !== "Xvfb" || !args.includes(display)) continue;
      const stat = FS.readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      servers.push({ pid: Number(pid), ppid, uid: FS.statSync(`/proc/${pid}`).uid, args });
    } catch {
      /* A disappearing process cannot qualify. */
    }
  }
  if (servers.length !== 1 || servers[0].ppid !== parentPid || servers[0].uid !== process.getuid())
    fail();
  const authAt = servers[0].args.indexOf("-auth");
  if (authAt < 0 || FS.realpathSync(servers[0].args[authAt + 1]) !== authority) fail();
  const git = (args) =>
    CP.execFileSync("/usr/bin/git", args, {
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  const head = git(["rev-parse", "HEAD"]).toString().trim();
  if (
    head !== process.env.GITHUB_SHA ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") ||
    !process.env.GITHUB_JOB
  )
    fail();
  const files = [
    "apps/desktop/src/electron/ElectronWindow.ts",
    "apps/desktop/src/preview/Manager.ts",
    "apps/desktop/src/window/DesktopWindow.ts",
    "apps/desktop/src/preview/BrowserSession.ts",
    "apps/desktop/src/snapShot/DesktopSnapShot.ts",
    "apps/desktop/src/snapShot/SnapShotTransition.ts",
    "apps/desktop/src/permissions/MacPermissionHelper.ts",
    "apps/desktop/src/electron/NixManagedUpdater.ts",
    "apps/desktop/src/electron/WindowsForegroundFocusThread.ts",
    "apps/desktop/src/snapShot/RegionSnapShot.ts",
    "apps/desktop/src/snapShot/SnapShotAccessibilityProcess.ts",
    "apps/desktop/src/electron/ElectronUpdater.ts",
    "apps/desktop/src/updates/DesktopUpdates.ts",
    "apps/desktop/scripts/core-update-admission-fixture/main.ts",
    "apps/desktop/scripts/core-update-admission-fixture/run.mjs",
    "apps/desktop/scripts/core-update-admission-fixture/vite.config.ts",
    "pnpm-lock.yaml",
  ];
  const sourceHashes = Object.fromEntries(
    files.map((file) => {
      const current = sha(FS.readFileSync(Path.join(root, file)));
      if (current !== sha(git(["show", `${head}:${file}`]))) fail();
      return [file, current];
    }),
  );
  const executable = FS.realpathSync(flags.get("--electron"));
  const preload = Path.join(root, "apps/desktop/dist-electron/preload.cjs");
  const binding = {
    scope: "CORE_UPDATE_ADMISSION_ONLY",
    nativePin: "9c66718304950879a203c11ce476237719e18831",
    nixPin: "abcc2efd064c436d417a70beeb1704d7796e9ebf",
    consumerPin: "661079b875bdc5ff1db66d6b0e9aa4b7a5bdb67a",
    actualInstaller: "NOT_EXERCISED",
    autofill: "NOT_EXERCISED",
    windows: "NOT_EXERCISED",
    macOS: "NOT_EXERCISED",
    source: head,
    sourceHashes,
    lockSha256: sourceHashes["pnpm-lock.yaml"],
    runId: process.env.GITHUB_RUN_ID,
    job: process.env.GITHUB_JOB,
    runner: process.env.RUNNER_NAME ?? "",
    assertedRunnerProfile: process.env.MORROWBYTE_RUNNER_PROFILE,
    runnerAttestation: "CALLER_ASSERTION_ONLY_REQUIRES_INTEGRATION_WORKFLOW_JOB_EVIDENCE",
    executable,
    executableSha256: sha(FS.readFileSync(executable)),
    expectedElectron: "44.4.5",
    entrySha256: sha(FS.readFileSync(entry)),
    wrapperSha256: sha(FS.readFileSync(URL.fileURLToPath(import.meta.url))),
    preload,
    preloadSha256: sha(FS.readFileSync(preload)),
    pipPreloadSha256: sha(
      FS.readFileSync(Path.join(Path.dirname(preload), "preview-pip-preload.cjs")),
    ),
    privateDisplayBound: true,
    xvfbPid: servers[0].pid,
    xvfbRunPid: parentPid,
    xvfbRunSha256: sha(FS.readFileSync(xvfbRun)),
  };
  temporary = FS.mkdtempSync(Path.join(runnerTemp, "core-update-admission-"));
  for (const folder of ["home", "runtime", "user-data", "session-data"])
    FS.mkdirSync(Path.join(temporary, folder), { mode: 0o700 });
  FS.writeFileSync(Path.join(temporary, ".owned"), "synthetic-core-update-admission", {
    mode: 0o600,
  });
  const bindingPath = Path.join(temporary, "binding.json");
  FS.writeFileSync(bindingPath, JSON.stringify(binding), { mode: 0o600 });
  const log = FS.openSync(Path.join(output, "electron.log"), "wx", 0o600);
  const child = CP.spawn(
    executable,
    [entry, "--output", output, "--temporary", temporary, "--binding", bindingPath, "--repo", root],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: Path.join(temporary, "home"),
        TMPDIR: temporary,
        XDG_RUNTIME_DIR: Path.join(temporary, "runtime"),
        DISPLAY: process.env.DISPLAY,
        XAUTHORITY: authority,
        LANG: "C.UTF-8",
        NODE_PATH: [
          Path.join(root, "apps/desktop/node_modules"),
          Path.join(root, "node_modules"),
        ].join(Path.delimiter),
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: head,
        GITHUB_RUN_ID: binding.runId,
        GITHUB_JOB: binding.job,
        MORROWBYTE_CORE_UPDATE_ADMISSION: "1",
        MORROWBYTE_RUNNER_PROFILE: binding.assertedRunnerProfile,
      },
    },
  );
  childPid = child.pid;
  let discardedBytes = 0,
    timedOut = false;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      discardedBytes += chunk.byteLength;
    });
  const timer = setTimeout(() => {
    timedOut = true;
    killOwned();
  }, 150000);
  const result = await new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, signal: null }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  killOwned();
  const temporaryRemoved = await removeOwned();
  let fixture;
  try {
    fixture = JSON.parse(FS.readFileSync(Path.join(output, "fixture-receipt.json"), "utf8"));
  } catch {
    /* Missing receipt fails even with exit0. */
  }
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
  ];
  const artifactNamesMatch =
    JSON.stringify(FS.readdirSync(output).sort()) ===
    JSON.stringify(["electron.log", "fixture-receipt.json", "fixture-receipt.partial.json"].sort());
  const requiredClassification = {
    heldPiPWithSameGuest: "NOT_REACHABLE_BY_CONTRACT",
    heldPopupWithSameGuest: "NOT_REACHABLE_BY_CONTRACT",
    heldPopupUnit: "SOURCE_ONLY_SEPARATE_CONSUMER_TEST",
    heldPiPUnit: "SOURCE_ONLY_SEPARATE_CONSUMER_TEST",
    nixAsync70: "ADAPTER_ONLY_SYNTHETIC_IO_REAL_NATIVE_REVOCATION",
    capture: "PRODUCTION_PIP_SYNTHETIC_LOOPBACK_ONLY_NO_SCREENSHOT_ARTIFACT",
    futureEvents: "NOT_CLAIMED_AFTER_OWNED_SHUTDOWN",
    popupRefusalCause: "GUEST_AND_POPUP_LIVE_NO_EXCLUSIVE_CAUSALITY",
  };
  const classificationMatches = Object.entries(requiredClassification).every(
    ([key, value]) => fixture?.classification?.[key] === value,
  );
  const passed =
    result.code === 0 &&
    result.signal === null &&
    !timedOut &&
    temporaryRemoved &&
    fixture?.passed === true &&
    fixture?.phase === "final" &&
    fixture?.cleanup === "complete" &&
    fixture?.scope === binding.scope &&
    fixture?.firstFailure === null &&
    fixture?.diagnosticsWriteFailed === false &&
    classificationMatches &&
    Object.keys(fixture?.checks ?? {}).length === required.length &&
    required.every((name) => fixture?.checks?.[name] === "PASS") &&
    artifactNamesMatch &&
    fixture?.autofill === "NOT_EXERCISED" &&
    fixture?.windows === "NOT_EXERCISED" &&
    fixture?.macOS === "NOT_EXERCISED" &&
    fixture?.actualInstaller === "NOT_EXERCISED" &&
    fixture?.runtime?.electron === "44.4.5" &&
    fixture?.runtime?.executable === executable &&
    fixture?.runtime?.sha256 === binding.executableSha256 &&
    JSON.stringify(fixture?.binding) === JSON.stringify(binding);
  FS.writeSync(
    log,
    JSON.stringify({ sanitized: true, discardedBytes, ...result, timedOut }) + "\n",
  );
  FS.closeSync(log);
  FS.writeFileSync(
    Path.join(output, "runner-receipt.json"),
    JSON.stringify(
      {
        ...binding,
        passed,
        ...result,
        timedOut,
        temporaryRemoved,
        integrationWorkflowJobEvidenceRequired: true,
        rawOutputDiscarded: true,
        artifactNamesMatch,
        classificationMatches,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  process.exit(passed ? 0 : 1);
}
void launch().catch(async () => {
  killOwned();
  await removeOwned();
  process.stderr.write("Core update admission prerequisite failed\n");
  process.exit(1);
});
