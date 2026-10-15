/** Node assertions, plus the explicit Namespace-only Electron child runner. */
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import {
  classifyContentMapping,
  receiptFailures,
  expectedElectron,
  serializeProbeReceipt,
  persistProbeReceipt,
} from "./proton-pass-compatibility.mjs";

if (process.argv.includes("--electron")) {
  await runNamespaceChild();
} else {
  NodeTest.test(
    "accepts native main-frame identity but rejects another tab/profile or stale navigation",
    () => {
      const expected = { tabId: 11, frames: [{ main: true, url: "http://127.0.0.1:1234/login" }] };
      const observation = {
        type: "content",
        href: expected.frames[0].url,
        sender: { tabId: 11, frameId: 0, url: expected.frames[0].url },
      };
      NodeAssert.equal(classifyContentMapping(observation, expected).status, "supported");
      NodeAssert.equal(
        classifyContentMapping(
          { ...observation, sender: { ...observation.sender, tabId: 12 } },
          expected,
        ).status,
        "unsupported",
      );
      NodeAssert.equal(
        classifyContentMapping(
          { ...observation, sender: { ...observation.sender, url: "http://127.0.0.1:4321/other" } },
          expected,
        ).status,
        "unsupported",
      );
      NodeAssert.equal(
        classifyContentMapping(
          { ...observation, href: "http://127.0.0.1:1234/before-redirect" },
          expected,
        ).status,
        "unknown",
      );
    },
  );
  NodeTest.test(
    "requires exact native subframe identity and never promotes missing evidence",
    () => {
      const frame = { main: false, frameTreeNodeId: 73, url: "http://127.0.0.1:4321/frame" };
      const observation = {
        type: "content",
        href: frame.url,
        sender: { tabId: 11, frameId: 73, url: frame.url },
      };
      NodeAssert.equal(
        classifyContentMapping(observation, { tabId: 11, frames: [frame] }).status,
        "supported",
      );
      NodeAssert.equal(
        classifyContentMapping(
          { ...observation, sender: { ...observation.sender, frameId: 0 } },
          { tabId: 11, frames: [frame] },
        ).status,
        "unsupported",
      );
      NodeAssert.equal(
        classifyContentMapping(observation, {
          tabId: 11,
          frames: [{ ...frame, frameTreeNodeId: undefined }],
        }).status,
        "unknown",
      );
      NodeAssert.equal(
        classifyContentMapping({ type: "content-error" }, { tabId: 11, frames: [frame] }).status,
        "unknown",
      );
    },
  );
  NodeTest.test(
    "receipt fails closed on incomplete harness evidence independently of API support",
    () => {
      const receipt = {
        runtime: { electron: expectedElectron, executableSha256: "a".repeat(64) },
        externalRequests: [],
        invariants: Object.fromEntries(
          [
            "workerBoot",
            "popupSameSession",
            "profileIsolation",
            "incognitoRejected",
            "mainFrameMapping",
            "subframeMapping",
            "redirectMapping",
            "focusMapping",
            "tabSeparation",
          ].map((key) => [key, true]),
        ),
        apiProfiles: {
          A: { "offscreen.createDocument": { status: "unsupported", error: "Real call failed" } },
          B: {},
        },
      };
      NodeAssert.deepEqual(receiptFailures(receipt), []);
      NodeAssert.equal(
        JSON.parse(serializeProbeReceipt(receipt, "partial", { status: "pending", errors: [] }, 0))
          .harnessPassed,
        false,
      );
      NodeAssert.equal(
        JSON.parse(serializeProbeReceipt(receipt, "final", { status: "complete", errors: [] }, 0))
          .harnessPassed,
        true,
      );
      NodeAssert.equal(
        JSON.parse(
          serializeProbeReceipt(
            { ...receipt, persistenceErrors: ["write failed"] },
            "final",
            { status: "complete", errors: [] },
            0,
          ),
        ).harnessPassed,
        false,
      );
      NodeAssert.ok(
        receiptFailures({
          ...receipt,
          invariants: { ...receipt.invariants, focusMapping: false },
        }).includes("Unproven invariant: focusMapping"),
      );
      NodeAssert.ok(
        receiptFailures({
          ...receipt,
          runtime: { ...receipt.runtime, electron: "43.6.0" },
        }).includes("Wrong Electron runtime"),
      );
      NodeAssert.ok(
        receiptFailures({
          ...receipt,
          externalRequests: [{ url: "https://example.invalid/", blocked: true }],
        }).includes("Unexpected network request"),
      );
      NodeAssert.ok(
        receiptFailures({ ...receipt, fatalError: "deadline exceeded" }).includes(
          "Probe did not finish",
        ),
      );
    },
  );
  NodeTest.test(
    "flushes a first partial failure before final cleanup diagnostics without overwriting it",
    async () => {
      const output = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "proton-receipt-assertion-"),
      );
      try {
        const receipt = {
          fatalError: "Original probe failure",
          stage: "guest-alpha",
          observations: [{ type: "worker-boot" }],
        };
        const partial = serializeProbeReceipt(
          receipt,
          "partial",
          { status: "pending", errors: [] },
          1,
        );
        persistProbeReceipt(output, partial, true);
        // This is real file IO/serialization proof, not a simulated Electron runtime.
        NodeAssert.equal(
          await NodeFSP.readFile(NodePath.join(output, "fixture-receipt.json"), "utf8"),
          partial,
        );
        NodeAssert.equal(JSON.parse(partial).harnessPassed, false);
        NodeAssert.equal(JSON.parse(partial).cleanup.status, "pending");
        const final = serializeProbeReceipt(
          receipt,
          "final",
          { status: "timed-out", errors: ["Cleanup deadline exceeded"] },
          1,
        );
        persistProbeReceipt(output, final);
        NodeAssert.equal(
          await NodeFSP.readFile(NodePath.join(output, "fixture-receipt.partial.json"), "utf8"),
          partial,
        );
        const saved = JSON.parse(
          await NodeFSP.readFile(NodePath.join(output, "fixture-receipt.json"), "utf8"),
        );
        NodeAssert.equal(saved.phase, "final");
        NodeAssert.equal(saved.fatalError, "Original probe failure");
        NodeAssert.equal(saved.cleanup.status, "timed-out");
        NodeAssert.deepEqual(saved.cleanup.errors, ["Cleanup deadline exceeded"]);
        NodeAssert.equal(saved.harnessPassed, false);
        NodeAssert.ok(receiptFailures(saved).includes("Cleanup did not complete"));
        NodeAssert.throws(() => persistProbeReceipt(output, "{}", true), { code: "EEXIST" });
        NodeAssert.equal(
          await NodeFSP.readFile(NodePath.join(output, "fixture-receipt.partial.json"), "utf8"),
          partial,
        );
        NodeAssert.equal(
          await NodeFSP.readFile(NodePath.join(output, "fixture-receipt.json"), "utf8"),
          final,
        );
      } finally {
        await NodeFSP.rm(output, { recursive: true, force: true });
      }
    },
  );
}

async function runNamespaceChild() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.MORROWBYTE_NAMESPACE_PROBE !== "1")
    throw new Error("Namespace Actions execution only; do not launch on a workstation");
  const electron = await NodeFSP.realpath(process.argv[process.argv.indexOf("--electron") + 1]);
  if (!process.argv.includes("--output")) throw new Error("Provide --output <artifact directory>");
  const output = NodePath.resolve(process.argv[process.argv.indexOf("--output") + 1]);
  const script = NodeURL.fileURLToPath(new URL("./proton-pass-compatibility.mjs", import.meta.url));
  const executableSha256 = NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(electron))
    .digest("hex");
  const temporary = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "morrowbyte-proton-probe-"),
  );
  await NodeFSP.writeFile(NodePath.join(temporary, ".owned-probe"), "synthetic-only");
  await NodeFSP.mkdir(NodePath.join(temporary, "user-data"));
  await NodeFSP.mkdir(NodePath.join(temporary, "session-data"));
  await NodeFSP.mkdir(output, { recursive: true });
  const log = await NodeFSP.open(NodePath.join(output, "electron.log"), "w");
  let child;
  let timer;
  let receipt;
  let childExit;
  try {
    // Never inherit ELECTRON_RUN_AS_NODE or remote-debugging switches.
    const inheritedNames = [
      "PATH",
      "HOME",
      "DISPLAY",
      "XAUTHORITY",
      "LD_LIBRARY_PATH",
      "XDG_RUNTIME_DIR",
      "LANG",
      "LC_ALL",
      "GITHUB_ACTIONS",
      "GITHUB_SHA",
      "GITHUB_RUN_ID",
      "GITHUB_JOB",
      "RUNNER_NAME",
      "MORROWBYTE_NAMESPACE_PROFILE",
      "MORROWBYTE_NAMESPACE_PROBE",
    ];
    const env = Object.fromEntries(
      inheritedNames.flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    );
    env.MORROWBYTE_PROBE_TEMP_ROOT = temporary;
    child = NodeChildProcess.spawn(electron, [script, "--output", output], {
      env,
      stdio: ["ignore", log.fd, log.fd],
    });
    childExit = await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Electron child exceeded 130 seconds"));
      }, 130000);
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    receipt = JSON.parse(
      await NodeFSP.readFile(NodePath.join(output, "fixture-receipt.json"), "utf8"),
    );
    NodeAssert.equal(
      receipt.runtime.executableSha256,
      executableSha256,
      "Child executed the hashed binary",
    );
    NodeAssert.equal(receipt.runtime.electron, expectedElectron);
  } finally {
    clearTimeout(timer);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGKILL");
      });
    }
    await log.close();
    await NodeFSP.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await NodeFSP.writeFile(
      NodePath.join(output, "runner-receipt.json"),
      JSON.stringify(
        {
          executable: electron,
          executableSha256,
          childExit: childExit ?? null,
          ownedTemporaryRootRemoved: true,
        },
        null,
        2,
      ),
    );
    if (receipt) {
      receipt.cleanup = { ...receipt.cleanup, ownedTemporaryRootRemoved: true };
      receipt.runnerExecutableSha256 = executableSha256;
      await NodeFSP.writeFile(
        NodePath.join(output, "fixture-receipt.json"),
        JSON.stringify(receipt, null, 2),
      );
    }
  }
  NodeAssert.equal(
    childExit.code,
    0,
    `Compatibility invariants failed; read ${NodePath.join(output, "fixture-receipt.json")}`,
  );
  NodeAssert.equal(receipt.harnessPassed, true);
  NodeAssert.deepEqual(receiptFailures(receipt), []);
}
