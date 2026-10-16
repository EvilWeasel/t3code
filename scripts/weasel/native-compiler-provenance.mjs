// PM576/577: hosted, passive compiler provenance. Never executes package code.
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, dirname, relative, join, basename, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

const BRANCH = "feature/native-compiler-provenance-candidate-20261016";
const LIMIT = Object.freeze({ samples: 500, interval: 20, milliseconds: 10_000,
  records: 64, childrenBytes: 4096, images: 4, imageBytes: 256 * 1024 ** 2,
  imageTotal: 512 * 1024 ** 2, files: 32, fileBytes: 1024 ** 2,
  fileTotal: 8 * 1024 ** 2, imports: 128, receiptBytes: 64 * 1024 });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = resolve(process.cwd());
const errors = new Map();
const unknown = (code) => errors.set(code, (errors.get(code) ?? 0) + 1);
const positivePid = (s) => /^[1-9][0-9]{0,9}$/.test(s) && Number.isSafeInteger(Number(s));
const inside = (base, path) => { const r = relative(base, path); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
const safePath = (path) => { if (path.length > 512 || /[\x00-\x1f\x7f]/.test(path)) throw Error("PATH_BOUND"); return path; };
async function bounded(path, cap) {
  const h = await fs.open(path, "r");
  try {
    const b = Buffer.alloc(cap + 1); let count = 0;
    while (count <= cap) {
      const { bytesRead } = await h.read(b, count, cap + 1 - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
      if (count > cap) throw Error("READ_BOUND");
    }
    return b.subarray(0, count);
  } finally { await h.close(); }
}
async function exclusive(path, bytes) { await fs.writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
async function jsonFile(path, value) {
  const b = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  if (b.length > LIMIT.receiptBytes) throw Error("RECEIPT_BOUND");
  await exclusive(path, b);
}
function environment() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "morrowbyte/t3code" ||
      process.env.GITHUB_REF_NAME !== BRANCH || !isAbsolute(process.env.RUNNER_TEMP ?? "") ||
      !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "") ||
      !/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? "") ||
      !/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")) throw Error("HOSTED_BINDING");
  return join(process.env.RUNNER_TEMP, "native-compiler-provenance");
}
async function stat(pid) {
  const text = (await bounded(`/proc/${pid}/stat`, 4096)).toString();
  const end = text.lastIndexOf(")"); const fields = text.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || text.slice(0, text.indexOf(" ")) !== String(pid) || fields.length < 20 ||
      !positivePid(fields[1]) || !/^[0-9]+$/.test(fields[19])) throw Error("STAT_SHAPE");
  return { pid, ppid: Number(fields[1]), start: fields[19] };
}
const same = (a, b) => a.pid === b.pid && a.ppid === b.ppid && a.start === b.start;

async function collectApis(output) {
  const require = createRequire(join(root, "apps/server/package.json"));
  const state = { roots: [], files: [], imports: [], compilerPaths: [], copiedBytes: 0, readBytes: 0 };
  const copied = new Set(); const importSeen = new Set();
  async function packageRoot(name, expected) {
    let path;
    try { path = require.resolve(`${name}/package.json`); }
    catch {
      for (const candidate of [join(root, "apps/server/node_modules", name, "package.json"), join(root, "node_modules", name, "package.json")]) {
        try { path = await fs.realpath(candidate); break; } catch { /* exact candidates only */ }
      }
    }
    if (!path) { unknown("PACKAGE_UNAVAILABLE"); return null; }
    const real = await fs.realpath(path); const base = dirname(real);
    // Only normally installed package roots; never a source/workspace substitute.
    if (!real.includes("/node_modules/")) throw Error("PACKAGE_ROOT");
    const bytes = await bounded(real, LIMIT.fileBytes);
    if (state.readBytes + bytes.length > LIMIT.fileTotal) throw Error("SOURCE_TOTAL_BOUND");
    state.readBytes += bytes.length;
    const manifest = JSON.parse(bytes.toString());
    if (manifest.name !== name || (expected && manifest.version !== expected)) { unknown("PACKAGE_VERSION_MISMATCH"); return null; }
    const id = state.roots.length; state.roots.push({ id, name, version: manifest.version, path: safePath(base), manifestSHA256: sha(bytes) });
    return { id, base, manifest };
  }
  async function readSource(pkg, path) {
    const real = await fs.realpath(path); if (!inside(pkg.base, real)) throw Error("PACKAGE_ESCAPE");
    const b = await bounded(real, LIMIT.fileBytes);
    if (state.readBytes + b.length > LIMIT.fileTotal) throw Error("SOURCE_TOTAL_BOUND");
    state.readBytes += b.length; return { real, b };
  }
  async function add(pkg, path, role, direct = false) {
    if (!pkg) return;
    try {
      const real = await fs.realpath(path); if (copied.has(real)) return;
      if (state.files.length >= LIMIT.files) throw Error("FILE_COUNT_BOUND");
      const { b } = await readSource(pkg, real);
      if (b.includes(0)) { unknown("BINARY_NOT_COPIED"); return; }
      const rel = safePath(relative(pkg.base, real));
      const name = `${String(state.files.length).padStart(2, "0")}-${basename(real)}`;
      await exclusive(join(output, "files", name), b);
      copied.add(real); state.copiedBytes += b.length;
      state.files.push({ package: pkg.id, path: rel, role, artifact: `files/${name}`, bytes: b.length, sha256: sha(b) });
      if (direct) {
        // Direct relative public-source imports only; no recursive follow/copy/evaluation.
        const matches = b.toString().matchAll(/(?:\bfrom\s*|\bimport\s*\(|\bexport\s*\*\s*from\s*)["'](\.[^"']+)["']/g);
        for (const m of matches) {
          if (state.imports.length >= LIMIT.imports) { unknown("IMPORT_COUNT_BOUND"); break; }
          const target = resolve(dirname(real), m[1]);
          if (!inside(pkg.base, target)) { unknown("IMPORT_ESCAPE"); continue; }
          if (importSeen.has(target)) continue; importSeen.add(target);
          try {
            const { real: imported, b: ib } = await readSource(pkg, target);
            state.imports.push({ package: pkg.id, path: safePath(relative(pkg.base, imported)), bytes: ib.length, sha256: sha(ib) });
          } catch { unknown("DIRECT_IMPORT_UNAVAILABLE_OR_BOUND"); }
        }
      }
    } catch { unknown("ALLOWLIST_FILE_UNAVAILABLE_OR_BOUND"); }
  }
  const effect = await packageRoot("effect", "4.0.5");
  const compiler = await packageRoot("tsc-rs", "0.7.0");
  const typescript = await packageRoot("typescript", "7.0.2");
  const integration = await packageRoot("@effect/tsgo", "0.51.1");
  for (const pkg of [effect, compiler, typescript, integration]) if (pkg) await add(pkg, join(pkg.base, "package.json"), "manifest");
  if (effect) {
    for (const [entry, module] of [["Crypto", "Crypto"], ["rpc", "RpcGroup"], ["rpc", "RpcServer"], ["rpc", "Rpc"], ["Schema", "Schema"], ["Layer", "Layer"]]) {
      let implementation;
      try {
        const resolved = require.resolve(`effect/${entry}`);
        if (entry !== "rpc") implementation = resolved;
        else {
          try { implementation = require.resolve(`effect/rpc/${module}`); }
          catch {
            // Read the actual public barrel's explicit module export, never guess
            // a historical Effect layout or recursively enumerate the package.
            await add(effect, resolved, "rpc:public-export-mapping", true);
            const { b } = await readSource(effect, resolved);
            const match = new RegExp(`export\\s+\\*\\s+as\\s+${module}\\s+from\\s+["'](\\.[^"']+)["']`).exec(b.toString());
            if (!match) throw Error("RPC_EXPORT_MAPPING_UNKNOWN");
            implementation = resolve(dirname(resolved), match[1]);
          }
        }
        await add(effect, implementation, `${module}:implementation`, true);
        const subpath = entry === "rpc" ? `rpc/${module}` : entry;
        const exported = effect.manifest.exports?.[`./${subpath}`] ?? effect.manifest.exports?.["./*"];
        const types = typeof exported === "object" && exported !== null ? exported.types : undefined;
        const declaration = typeof types === "string"
          ? resolve(effect.base, types.replaceAll("*", subpath))
          : implementation.replace(/\.js$/, ".d.ts");
        if (declaration === implementation) unknown("EFFECT_DECLARATION_MAPPING_UNKNOWN");
        else await add(effect, declaration, `${module}:declaration`, true);
      } catch { unknown("EFFECT_EXPORT_UNAVAILABLE"); }
    }
  }
  for (const [pkg, binName] of [[compiler, "tsc-rs"], [integration, "effect-tsgo"]]) {
    if (!pkg) continue;
    const bin = typeof pkg.manifest.bin === "string" ? pkg.manifest.bin : pkg.manifest.bin?.[binName];
    if (typeof bin === "string") {
      const path = resolve(pkg.base, bin); if (!inside(pkg.base, path)) throw Error("BIN_ESCAPE");
      state.compilerPaths.push({ package: pkg.id, role: binName, path: safePath(path) });
      await add(pkg, path, `${binName}:launcher`, true);
    } else unknown("BIN_UNAVAILABLE");
  }
  if (compiler) {
    // Read at most the exact Linux/x64 optional platform manifest/bin, not all packages.
    const names = Object.keys(compiler.manifest.optionalDependencies ?? {}).filter((n) => /linux/.test(n) && /(?:x64|x86_64)/.test(n));
    if (names.length === 1) {
      const platform = await packageRoot(names[0], compiler.manifest.optionalDependencies[names[0]]);
      if (platform) {
        await add(platform, join(platform.base, "package.json"), "compiler-platform-manifest");
        const bin = typeof platform.manifest.bin === "string" ? platform.manifest.bin : platform.manifest.bin?.["tsc-rs"];
        if (typeof bin === "string" && inside(platform.base, resolve(platform.base, bin))) state.compilerPaths.push({ package: platform.id, role: "tsc-rs-platform-image", path: safePath(resolve(platform.base, bin)) });
      }
    } else unknown("COMPILER_PLATFORM_PACKAGE_UNKNOWN");
  }
  if (typescript) await add(typescript, join(typescript.base, "lib/tsc.js"), "patched-TypeScript-tsc-NOT-tsc-rs", true);
  if (integration) {
    for (const file of ["dist/index.js", "dist/patch.js"]) await add(integration, join(integration.base, file), "Effect-integration-source", true);
  }
  // Exact package-manager shim paths only. Resolve symlinks inside the package roots.
  for (const path of [join(root, "apps/server/node_modules/.bin/tsc-rs"), join(root, "node_modules/.bin/tsc-rs")]) {
    try {
      const real = await fs.realpath(path);
      const pkg = [compiler, ...state.roots.filter((p) => p.name.startsWith("@tsc-rs/")).map((p) => ({ id: p.id, base: p.path }))].find((p) => p && inside(p.base, real));
      if (pkg) await add(pkg, real, "package-manager-resolved-tsc-rs-shim");
      else if (compiler && inside(root, real) && real.includes("/node_modules/.bin/")) {
        // A generated shim is outside its target package root but exactly allowlisted.
        const b = await bounded(real, LIMIT.fileBytes);
        if (state.files.length >= LIMIT.files || state.readBytes + b.length > LIMIT.fileTotal || b.includes(0)) throw Error("SHIM_BOUND");
        state.readBytes += b.length; const name = `${state.files.length}-tsc-rs-shim.txt`;
        await exclusive(join(output, "files", name), b);
        state.files.push({ package: compiler.id, path: safePath(relative(root, real)), role: "generated-shim", artifact: `files/${name}`, bytes: b.length, sha256: sha(b) });
      } else unknown("SHIM_ROOT_UNKNOWN");
    } catch { unknown("SHIM_UNAVAILABLE_OR_BOUND"); }
  }
  const lock = await bounded(join(root, "pnpm-lock.yaml"), 8 * 1024 ** 2);
  state.lockSHA256 = sha(lock);
  // Fixed package lock blocks only, not environment/config or an unbounded lock copy.
  state.lockIntegrity = [];
  const names = ["effect@4.0.5", "tsc-rs@0.7.0", "typescript@7.0.2", "@effect/tsgo@0.51.1"];
  const lines = lock.toString().split("\n");
  for (const name of names) {
    const candidates = lines.map((line, i) => ({ line, i })).filter(({ line }) => line.trim().replace(/^['"]|['"]:?$/g, "").startsWith(name));
    const integrities = new Set();
    for (const { i } of candidates) for (const line of lines.slice(i + 1, i + 5)) {
      const value = /integrity:\s*(sha512-[A-Za-z0-9+/=]+)/.exec(line)?.[1]; if (value) integrities.add(value);
    }
    state.lockIntegrity.push({ name, integrities: [...integrities].slice(0, 2), status: integrities.size === 1 ? "DECLARED_LOCK_INTEGRITY" : "UNKNOWN" });
  }
  return state;
}

async function commandExit(output) {
  try {
    const path = join(dirname(output), "native-compiler-provenance-exit.json");
    const info = await fs.lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) throw Error("EXIT_IDENTITY");
    const v = JSON.parse((await bounded(path, 1024)).toString());
    if (v.observerPid !== process.pid || !Number.isInteger(v.exit) || v.exit < 0 || v.exit > 255 ||
        !/^[0-9]+\.[0-9]+$/.test(v.started) || !/^[0-9]+\.[0-9]+$/.test(v.ended) || Number(v.started) > Number(v.ended)) throw Error("EXIT_SHAPE");
    return v;
  } catch (error) {
    if (error?.code !== "ENOENT") unknown("COMMAND_EXIT_UNKNOWN");
    return null;
  }
}
async function observe(output, rootPid) {
  const began = performance.now(); const at = new Date().toISOString();
  await fs.mkdir(output, { mode: 0o700 }); await fs.mkdir(join(output, "files"), { mode: 0o700 });
  await jsonFile(join(output, "started.json"), { at, source: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, rootPid, observerPid: process.pid, limits: LIMIT });
  let invocation;
  try { invocation = await stat(rootPid); if (process.ppid !== rootPid) throw Error("ROOT_PARENT"); }
  catch { await jsonFile(join(output, "root-unknown.json"), { at, status: "UNKNOWN_INVOCATION_ROOT", rootPid }); return; }
  const records = new Map(); const images = new Map(); const attemptedImages = new Set(); let imageBytes = 0; let samples = 0;
  const apiPromise = collectApis(output).catch(() => { unknown("API_COLLECTION_UNKNOWN"); return null; });
  async function image(identity) {
    if (performance.now() - began >= LIMIT.milliseconds) { unknown("IMAGE_DEADLINE"); return null; }
    try {
      const exe = safePath(await fs.readlink(`/proc/${identity.pid}/exe`));
      if (!same(identity, await stat(identity.pid))) throw Error("PID_CHANGED");
      const h = await fs.open(`/proc/${identity.pid}/exe`, "r");
      try {
        const before = await h.stat();
        const imageKey = `${exe}:${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}`;
        const prior = images.get(imageKey);
        if (prior) { if (!same(identity, await stat(identity.pid))) throw Error("PID_CHANGED"); return prior.id; }
        if (attemptedImages.has(imageKey)) { unknown("IMAGE_PREVIOUSLY_UNAVAILABLE"); return null; }
        if (attemptedImages.size >= LIMIT.images) { unknown("IMAGE_COUNT_BOUND"); return null; }
        attemptedImages.add(imageKey);
        if (!before.isFile() || before.size > LIMIT.imageBytes || imageBytes + before.size > LIMIT.imageTotal) throw Error("IMAGE_SIZE_BOUND");
        imageBytes += before.size; // Failed/partial reads consume budget too; never retry this image.
        const hash = createHash("sha256"); let count = 0;
        for await (const bytes of h.createReadStream({ autoClose: false, highWaterMark: 1024 ** 2 })) {
          count += bytes.length; if (count > before.size || performance.now() - began >= LIMIT.milliseconds) throw Error("IMAGE_READ_BOUND"); hash.update(bytes);
        }
        const after = await h.stat(); if (count !== before.size || before.ino !== after.ino || before.size !== after.size || !same(identity, await stat(identity.pid))) throw Error("IMAGE_IDENTITY_CHANGED");
        const item = { id: images.size, path: exe, device: before.dev, inode: before.ino, bytes: count, sha256: hash.digest("hex") }; images.set(imageKey, item); return item.id;
      } finally { await h.close(); }
    } catch { unknown("IMAGE_UNKNOWN"); return null; }
  }
  try {
    while (samples < LIMIT.samples && performance.now() - began < LIMIT.milliseconds) {
      if (await commandExit(output)) break;
      if (!same(invocation, await stat(rootPid))) { unknown("INVOCATION_IDENTITY_CHANGED"); break; }
      let visits = 0; const queue = [invocation]; const seen = new Set([rootPid]);
      while (queue.length && visits < LIMIT.records && performance.now() - began < LIMIT.milliseconds) {
        const parent = queue.shift(); visits += 1;
        try {
          if (!same(parent, await stat(parent.pid))) throw Error("PARENT_CHANGED");
          const raw = (await bounded(`/proc/${parent.pid}/task/${parent.pid}/children`, LIMIT.childrenBytes)).toString().trim();
          if (raw && !/^[1-9][0-9]*(?:\s+[1-9][0-9]*)*$/.test(raw)) throw Error("CHILDREN_SHAPE");
          const children = raw ? raw.split(/\s+/) : []; if (children.length > LIMIT.records) throw Error("CHILD_COUNT");
          const parentAfter = await stat(parent.pid); if (!same(parent, parentAfter)) throw Error("PARENT_CHANGED");
          for (const token of children) {
            if (!positivePid(token)) throw Error("CHILD_PID"); const pid = Number(token);
            if (pid === process.pid || seen.has(pid)) continue; seen.add(pid);
            if (seen.size > LIMIT.records) { unknown("PROCESS_RECORD_BOUND"); break; }
            const child = await stat(pid); if (child.ppid !== parent.pid || !same(parent, await stat(parent.pid))) throw Error("CHILD_REPARENTED");
            const key = `${pid}:${child.start}`;
            if (!records.has(key) && records.size >= LIMIT.records) { unknown("TOTAL_RECORD_BOUND"); continue; }
            const id = await image(child);
            if (!same(child, await stat(pid)) || !same(parent, await stat(parent.pid))) throw Error("CHILD_CHANGED");
            const previous = records.get(key);
            records.set(key, { ...child, parentStart: parent.start, image: id, firstSample: previous?.firstSample ?? samples, lastSample: samples });
            queue.push(child);
          }
        } catch { unknown("DESCENDANT_IDENTITY_OR_DISCOVERY_UNKNOWN"); }
      }
      samples += 1;
      const remaining = LIMIT.milliseconds - (performance.now() - began);
      if (remaining > 0) await new Promise((done) => setTimeout(done, Math.min(LIMIT.interval, remaining)));
    }
  } catch { unknown("SAMPLER_UNKNOWN"); }
  const sampledMilliseconds = performance.now() - began;
  const canonicalCommandExit = await commandExit(output);
  const api = await apiPromise;
  const observed = [...images.values()];
  const compilerImages = observed.filter((item) => /(?:^|\/)tsc-rs(?:\.exe)?$/.test(item.path) &&
    api?.roots.some((pkg) => pkg.name.includes("tsc-rs") && inside(pkg.path, item.path)));
  const binding = {};
  for (const path of ["scripts/weasel/native-compiler-provenance.mjs", "scripts/weasel/check.sh", ".github/workflows/weasel-ci.yml", "pnpm-lock.yaml"]) {
    try { binding[path] = sha(await bounded(join(root, path), 8 * 1024 ** 2)); } catch { unknown("SOURCE_BINDING_UNKNOWN"); }
  }
  const receipt = { at, source: process.env.GITHUB_SHA, effectiveSource: process.env.EFFECTIVE_SOURCE_SHA,
    run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    trustedWorkflowSha: process.env.GITHUB_WORKFLOW_SHA, trustedWorkflowRef: process.env.GITHUB_WORKFLOW_REF,
    sourceHeadBinding: "Existing unchanged workflow asserts git rev-parse HEAD equals EFFECTIVE_SOURCE_SHA immediately before check.sh",
    invocation, canonicalCommandExit, observerPid: process.pid, command: 'vp_cmd run --filter="$package" typecheck', package: "t3",
    bounds: LIMIT, samples, sampledMilliseconds, samplerDeadline: "10s cooperative I/O deadline; actual elapsed reported without clamping",
    records: [...records.values()], images: observed, compilerImages,
    finalCompilerIdentity: compilerImages.length === 1 ? "OBSERVED_PACKAGE_IMAGE_NOT_VERSION_EXECUTED" : "UNKNOWN",
    coverage: "UNKNOWN_MAIN_THREAD_CHILDREN_MAY_MISS_TRANSIENT_OR_OTHER_THREAD_DESCENDANTS",
    nodeOrVpIsNotCompilerProof: true, executableBytesCopied: 0, api, binding,
    unknowns: [...errors].map(([code, count]) => ({ code, count })),
    limits: ["No environment/cmdline/cgroup/global-proc scan", "No package evaluation/compiler/version invocation", "Patched TS tsc is distinct from observed tsc-rs", "No compiler-cause or native runtime PASS"] };
  try { await jsonFile(join(output, "receipt.json"), receipt); }
  catch { await jsonFile(join(output, "receipt-bound-unknown.json"), { at, source: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, status: "UNKNOWN_RECEIPT_BOUND_OR_WRITE", filesRemainBounded: true }); }
}

// No output to the canonical typecheck streams and no arbitrary error serialization.
try {
  const output = environment(); const [mode, value, exit] = process.argv.slice(2);
  if (mode === "observe" && positivePid(value ?? "") && exit === undefined) await observe(output, Number(value));
 else throw Error("MODE");
} catch { process.exitCode = 1; }
