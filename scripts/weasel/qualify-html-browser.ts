// @effect-diagnostics nodeBuiltinImport:off - an isolated Namespace CI fixture runner.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import * as PreviewBrowser from "../../apps/server/src/preview/PreviewBrowser.ts";

interface AssertionResult {
  readonly title: string;
  readonly fullName: string;
  readonly status: string;
}

interface TestResult {
  readonly name: string;
  readonly assertionResults: ReadonlyArray<AssertionResult>;
}

interface VitestReport {
  readonly success: boolean;
  readonly numPendingTests: number;
  readonly testResults: ReadonlyArray<TestResult>;
}

const root = process.cwd();
const runnerTemp = process.env.RUNNER_TEMP;
if (!runnerTemp) throw new Error("RUNNER_TEMP is required for isolated browser fixtures.");

const fixtureHome = NodePath.join(runnerTemp, "t3-html-fixtures");
const reportPath = NodePath.join(runnerTemp, "t3-html-fixtures-report.json");
const executable = await Effect.runPromise(
  PreviewBrowser.makePreviewBrowser({ baseDir: fixtureHome }).pipe(
    Effect.flatMap((browser) => browser.executable),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
const relativeExecutable = NodePath.relative(fixtureHome, executable);
if (relativeExecutable.startsWith("..") || NodePath.isAbsolute(relativeExecutable)) {
  throw new Error("The pinned preview browser was installed outside the isolated fixture home.");
}
console.log(`Using T3's SHA-256-verified preview browser: ${executable}`);

const testFiles = [
  "apps/server/src/htmlRender/HtmlRender.test.ts",
  "apps/server/src/mcp/toolkits/html/tools.test.ts",
];
const command = NodeChildProcess.spawnSync(
  "vp",
  [
    "test",
    "run",
    "--config",
    "vite.config.ts",
    "--reporter=json",
    `--outputFile=${reportPath}`,
    ...testFiles,
  ],
  {
    cwd: root,
    env: { ...process.env, T3CODE_TEST_HEADLESS_SHELL: executable },
    stdio: "inherit",
  },
);
if (command.error) throw command.error;
if (command.status !== 0) {
  throw new Error(`Focused HTML fixture tests exited with ${command.status ?? command.signal}.`);
}

const report = JSON.parse(NodeFS.readFileSync(reportPath, "utf8")) as VitestReport;
if (!report.success || report.numPendingTests !== 0) {
  throw new Error(
    `HTML fixture report was not fully executed: success=${report.success}, pending=${report.numPendingTests}.`,
  );
}
const assertions = report.testResults.flatMap((result) => result.assertionResults);
const expected = [
  "screenshots the page in headless Chrome with the requested theme and every console level",
  "keeps every local file but the page itself out of the browser",
  "keeps the page off this machine's local network",
  "measures a published page at every client width with a fresh load each",
  "publishes the prepared page as an html thread attachment",
  "keeps interactive diagram revisions discoverable only in their thread",
  "supports durable, editable diagrams through the isolated HTML artifact surface",
];
for (const title of expected) {
  const matches = assertions.filter((assertion) => assertion.title === title);
  if (matches.length !== 1 || matches[0]?.status !== "passed") {
    throw new Error(
      `Expected exactly one passed HTML fixture "${title}"; found ${matches.length} with status ${matches[0]?.status ?? "missing"}.`,
    );
  }
}

console.log("Executed and passed all 4 headless HtmlRender fixtures; zero tests skipped.");
console.log("Also passed offline publish, thread revision, and HTML tool guidance fixtures.");
for (const title of expected) console.log(`PASS ${title}`);
