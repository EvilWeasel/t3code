// Namespace-only visual fixtures: real components/styles, synthetic state and no media/provider access.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const web = join(repo, "apps/web");
const webRequire = createRequire(join(web, "package.json"));
const serverRequire = createRequire(join(repo, "apps/server/package.json"));
const { createServer } = await import(pathToFileURL(webRequire.resolve("vite")));
const { default: react } = await import(pathToFileURL(webRequire.resolve("@vitejs/plugin-react")));
const { default: tailwind } = await import(pathToFileURL(webRequire.resolve("@tailwindcss/vite")));
const { chromium } = serverRequire("playwright-core");
const cli = join(dirname(serverRequire.resolve("playwright-core/package.json")), "cli.js");
const install = spawnSync(process.execPath, [cli, "install", "--with-deps", "chromium"], { stdio: "inherit" });
if (install.status !== 0) throw new Error("Pinned Namespace browser installation failed");
const output = resolve(process.argv[2] ?? "product-evidence/voice-ui");
await mkdir(output, { recursive: true });
await mkdir(join(repo, ".t3"), { recursive: true });
const fixture = await mkdtemp(join(repo, ".t3/voice-ui-"));
const mock = (code) => `import React from "react"; ${code}`;
const mocks = new Map([
  ["@tanstack/react-router", mock('export const useLocation = (o) => o.select({hash:"",state:{},pathname:"/settings/integrations"}); export const useNavigate=()=>()=>{}; export const Link=({children,...p})=>React.createElement("a",p,children);')],
  [join(web, "src/components/settings/SettingsScopeContext"), 'export const useSettingsScope=()=>({target:{environmentId:"fixture"},scope:{kind:"environment",environmentId:"fixture",label:"Synthetic fixture host"}}); export const useOptionalSettingsScope=()=>null;'],
  [join(web, "src/state/session"), 'export const readEnvironmentScope=()=>true; export const useEnvironmentScope=()=>true; export const useEnvironmentsWithScope=()=>new Set(["fixture"]);'],
  [join(web, "src/state/environments"), 'export const usePrimaryEnvironmentId=()=>"fixture"; export const usePrimaryEnvironment=()=>({label:"Synthetic fixture host"});'],
  [join(web, "src/hooks/useSettings"), 'export const usePrimarySettingsAvailable=()=>true; export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE="Fixture unavailable";'],
  [join(web, "src/components/settings/settingsSearch"), 'export const searchableSetting=()=>({});'],
  [join(web, "src/composerDraftStore"), 'export const DraftId={make:(value)=>value};'],
  [join(web, "src/components/settings/useScopedSettings"), 'export const useClearScopedSettings=()=>()=>{}; export const useClearProjectOverrides=()=>()=>{};'],
  [join(web, "src/components/settings/SettingInheritance"), 'export const SettingInheritance=()=>null;'],
  [join(web, "src/components/settings/SettingsScopeSentence"), 'export const SettingsScopeSentence=()=>null;'],
  [join(web, "src/voice/voiceSettingsClient"), 'export const voiceSettingsRequest=async()=>({provider:new URLSearchParams(location.search).get("provider")||"openai-api",instanceId:null,model:"gpt-transcribe",apiKeyConfigured:true,apiKeySource:"saved",supportsEncryptedApiKeyStorage:true,available:true,message:"Synthetic configured provider",instances:[{id:"codex-fixture",label:"Fixture Codex account",authenticated:true}]}); export const voiceSettingsErrorMessage=()=>"Synthetic settings failure";'],
  [join(web, "src/voice/useVoiceDictation"), mock('export class VoiceDictationServiceError extends Error{}; export const useVoiceDictation=()=>{const phase=new URLSearchParams(location.search).get("phase")||"review"; return {state:{phase,message:"Synthetic provider error. ".repeat(30),audioUrl:phase==="recording"?undefined:"data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="},start:()=>{},stop:()=>{},cancel:()=>{},transcribe:()=>{}}};')],
]);
const mockPlugin = {
  name: "voice-fixture-boundaries", enforce: "pre",
  resolveId(source, importer) {
    const key = source.startsWith(".") && importer ? resolve(dirname(importer), source) : source;
    const normalized = key.replace(/\.(tsx?|jsx?)$/, "");
    if (mocks.has(normalized)) return "\0voice-fixture:" + normalized;
  },
  load(id) { if (id.startsWith("\0voice-fixture:")) return mocks.get(id.slice("\0voice-fixture:".length)); },
};
await writeFile(join(fixture, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
// The fixture root is gitignored; Tailwind needs explicit real-component sources.
await writeFile(join(fixture, "fixture.css"), `@import ${JSON.stringify(join(web, "src/index.css"))};\n@source ${JSON.stringify(join(web, "src"))};\n@source "./main.tsx";\n`);
await writeFile(join(fixture, "main.tsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import "./fixture.css";
import {VoiceTranscriptionSettingsPanel} from ${JSON.stringify(join(web, "src/components/settings/VoiceTranscriptionSettings.tsx"))};
import {VoiceDictationControl} from ${JSON.stringify(join(web, "src/voice/VoiceDictationControl.tsx"))};
document.documentElement.className=new URLSearchParams(location.search).get("theme")==="dark"?"dark":"light";
createRoot(document.getElementById("root")!).render(<main className="min-h-screen bg-background p-4 text-foreground"><VoiceTranscriptionSettingsPanel/><div className="mt-96 flex justify-end rounded-xl border border-border bg-card p-4"><VoiceDictationControl targetKey="fixture:draft" currentTargetKey={()=>"fixture:draft"} transcribe={async()=>"Synthetic words"} onTranscript={()=>true} onSend={async()=>true}/></div></main>);
`);
let browser;
const server = await createServer({
  configFile: false, root: fixture, plugins: [mockPlugin, react(), tailwind()],
  resolve: { alias: { "~": join(web, "src"), "react-dom": dirname(webRequire.resolve("react-dom/package.json")), "react": dirname(webRequire.resolve("react/package.json")) } },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } },
});
const results = [];
let currentCase;
const diagnosticUrl = (value) => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 300);
  } catch { return "unavailable"; }
};
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [360, 1024]) for (const theme of ["light", "dark"]) for (const [provider, phase] of [["openai-api","review"],["codex-account","recording"],["openai-api","error"],["openai-api","transcribing"]]) {
    const name = `${width}-${theme}-${provider}-${phase}`;
    const page = await browser.newPage({ viewport: { width, height: 1100 }, reducedMotion: "reduce" });
    const errors = [];
    const failedRequests = [];
    currentCase = { name, errors, failedRequests, stage: "navigation" };
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("requestfailed", (request) => {
      if (failedRequests.length < 20) failedRequests.push({url:diagnosticUrl(request.url()),failure:request.failure()?.errorText});
    });
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw Error("Real microphone forbidden in fixture"); }; });
    const deadline = Date.now() + 30_000;
    const remaining = () => {
      if (Date.now() >= deadline) throw new Error(`Fixture readiness deadline exceeded: ${name}`);
      return deadline - Date.now();
    };
    try {
    await page.goto(`${origin}/?${new URLSearchParams({theme,provider,phase})}`, {timeout:remaining()});
    currentCase.stage = "module-requests-idle";
    await page.waitForLoadState("networkidle", {timeout:remaining()});
    currentCase.stage = "visible-settings";
    await page.getByRole("button", {name:"Save voice settings"}).waitFor({state:"visible",timeout:remaining()});
    await page.getByText("Synthetic configured provider", {exact:true}).waitFor({timeout:remaining()});
    await page.evaluate(() => document.fonts.ready);
    if (await page.locator("main").evaluate((element) => getComputedStyle(element).paddingTop) !== "16px") throw Error("Fixture Tailwind utilities are missing");
    await page.screenshot({path:join(output,name+".png"),fullPage:true});
    if (phase === "error") {
      await page.getByText("Error details", {exact:true}).click();
      await page.screenshot({path:join(output,name+"-expanded.png"),fullPage:true});
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    results.push({name,overflow,errors});
    if (errors.length || overflow) throw Error(JSON.stringify(results.at(-1)));
    currentCase = undefined;
    } catch (error) {
      currentCase.failure = String(error.message).slice(0, 2000);
      currentCase.pageUrl = diagnosticUrl(page.url());
      if (page.url().startsWith(origin + "/")) {
        await page.screenshot({path:join(output,name+"-failure.png"),fullPage:true,timeout:5000}).catch(() => {});
        await page.content().then(html => writeFile(join(output,name+"-failure.html"),html.slice(0,262144))).catch(() => {});
      }
      throw error;
    } finally {
      await page.close();
    }
  }
} finally {
  await writeFile(join(output,"fixture-receipt.json"),JSON.stringify({scope:"Real components/styles with synthetic boundaries; no microphone/provider/runtime acceptance",results,currentCase},null,2));
  await browser?.close();
  await server.close();
  await rm(fixture,{recursive:true,force:true});
}
