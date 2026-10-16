// CI-only visual fixtures: real components/styles, synthetic state and no media/provider access.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
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
if (install.status !== 0) throw new Error("Pinned CI browser installation failed");
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
  for (const width of process.argv.includes("--composer-mobile") ? [] : [360, 1024]) for (const theme of ["light", "dark"]) for (const [provider, phase] of [["openai-api","review"],["codex-account","recording"],["openai-api","error"],["openai-api","transcribing"]]) {
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


// This mode runs in check before the unrelated server type gate. Legacy product capture stays above.
if (process.argv.includes("--composer-mobile")) await captureComposerMobile();
async function captureComposerMobile() {
  // Both variants use the exact a86 dependency graph. Only the production UI modules differ.
  const baseline = "a86d942da9e89ed382d2bfd7295b1e90ab2bc429";
  const uiPaths = ["apps/web/src/components/chat/ChatComposer.tsx", "apps/web/src/voice/LiveVoiceControl.tsx"];
  const source = Object.fromEntries(uiPaths.map(path => {
    const result = spawnSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8", maxBuffer: 2_000_000 });
    if (result.status !== 0) throw Error("Exact baseline UI source unavailable");
    return [join(repo, path), result.stdout];
  }));
  const digest = value => createHash("sha256").update(value).digest("hex");
  const bindings = [];
  for (const path of uiPaths) bindings.push({path, before: digest(source[join(repo,path)]), after: digest(await readFile(join(repo,path)))});
  const cases = [];
  let failure;
  for (const variant of ["before", "after"]) {
    const directory = await mkdtemp(join(repo, ".t3/composer-mobile-"));
    const partial = (path, code) => `export * from ${JSON.stringify(path + "?fixture-real")}; ${code}`;
    const env = "composer-mobile-fixture";
    const atoms = `import {Atom,AsyncResult} from "effect/reactivity"; const empty=Atom.make(AsyncResult.initial());`;
    const config = `const provider={driver:"codex",instanceId:"codex",enabled:true,installed:true,status:"ready",auth:{status:"authenticated"},version:null,checkedAt:"2026-10-15T00:00:00.000Z",models:["gpt-6.1-sol","synthetic-alternate"].map(slug=>({slug,name:slug==="synthetic-alternate"?"Synthetic alternate model":new URLSearchParams(location.search).get("catalog")==="long"?"GPT-6.1-Sol · synthetic long model and context selection":"GPT-6.1-Sol",isCustom:false,capabilities:{optionDescriptors:[{id:"reasoningEffort",label:"Reasoning effort",type:"select",currentValue:"medium",options:[{id:"medium",label:"Medium",isDefault:true},{id:"high",label:"High"}]}]}})),slashCommands:[],skills:[]}; const config={environment:{environmentId:${JSON.stringify(env)}},providers:[provider],settings:{providerInstances:{},projectSettingsOverrides:{}}};`;
    const boundaries = new Map([
      [join(web,"src/hooks/useSettings"), partial(join(web,"src/hooks/useSettings.ts"), 'export const usePrimarySettingsAvailable=()=>true;export const useEnvironmentModelPreferences=()=>({favorites:[],hidden:[],recent:[]});export const useToggleEnvironmentModelFavorite=()=>()=>{throw Error("Fixture settings mutation forbidden");};')],
      ["@tanstack/react-router", mock('export const useLocation=(o)=>o.select({hash:"",state:{},pathname:"/fixture"});const params=Object.freeze({environmentId:"composer-mobile-fixture",threadId:"composer-mobile-fixture-thread"});export const useParams=(options={})=>options.select?options.select(params):params;export const useNavigate=()=>()=>{};export const Link=({children,to,...p})=>React.createElement("a",{...p,href:to},children);')],
      [join(web,"src/state/server"), partial(join(web,"src/state/server.ts"), `${atoms}${config} import {serverEnvironment as actual} from ${JSON.stringify(join(web,"src/state/server.ts")+"?fixture-real")}; const value=Atom.make(config);const projection=Atom.make(AsyncResult.success({config}));export const serverEnvironment={...actual,configValueAtom:()=>value,configProjection:()=>projection,refreshProviders:{label:"fixture-refresh"}};`)],
      [join(web,"src/state/session"), partial(join(web,"src/state/session.ts"), `${atoms} import {environmentSession as actual} from ${JSON.stringify(join(web,"src/state/session.ts")+"?fixture-real")}; const session=Atom.make(AsyncResult.success({}));export const environmentSession={...actual,sessionStateAtom:()=>session};export const useEnvironmentScope=()=>true;export const readEnvironmentScope=()=>true;export const readPreparedConnection=()=>null;export const usePreparedConnection=()=>({_tag:"None"});`)],
      [join(web,"src/state/environments"), partial(join(web,"src/state/environments.ts"), `export const usePrimaryEnvironmentId=()=>${JSON.stringify(env)};export const usePrimaryEnvironment=()=>({environmentId:${JSON.stringify(env)},label:"Synthetic fixture"});`)],
      [join(web,"src/state/entities"), partial(join(web,"src/state/entities.ts"), 'const shells=[];export const useThreadShells=()=>shells;export const readThreadShell=()=>null;export const useThreadProjection=()=>null;')],
      [join(web,"src/state/use-atom-command"), 'import {useCallback} from "react";export const useAtomCommand=(command)=>useCallback(async()=>{window.composerFixture.forbiddenCommands++;throw Error("Fixture command forbidden");},[command]);'],
      [join(web,"src/state/use-atom-query-runner"), 'export const useAtomQueryRunner=()=>async()=>{window.composerFixture.forbiddenCommands++;throw Error("Fixture query forbidden");};'],
      [join(web,"src/state/liveVoice"), `${atoms} export const liveVoiceEnvironment={prepare:{},start:{},stop:{},status:{},events:()=>empty};`],
      [join(web,"src/lib/composerPathSearchState"), 'const entries=[];export const useComposerPathSearch=()=>({entries,error:null,isPending:false});'],
      [join(web,"src/state/pullRequests"), partial(join(web,"src/state/pullRequests.ts"), 'const view={data:null,error:null,isPending:false};export const usePullRequestList=()=>view;')],
      [join(web,"src/state/query"), partial(join(web,"src/state/query.ts"), 'export const useEnvironmentQuery=()=>({data:null,error:null,isPending:false,isSuccess:false,refresh:()=>{}});')],
      [join(web,"src/assets/assetUrls"), partial(join(web,"src/assets/assetUrls.ts"), 'const urls=[];export const useAssetUrls=()=>urls;')],
      [join(web,"src/voice/useVoiceDictation"), mock('export class VoiceDictationServiceError extends Error{};export const useVoiceDictation=()=>({state:{phase:"idle"},start:()=>{window.composerFixture.forbiddenCommands++;throw Error("Fixture media forbidden");},stop:()=>{},cancel:()=>{},transcribe:()=>{throw Error("Fixture provider forbidden");}});')],
    ]);
    const plugin = {
      name: "composer-isolated-boundaries", enforce: "pre",
      resolveId(request, importer) {
        if (request.endsWith("?fixture-real")) return request.slice(0,-13);
        let key = request.startsWith(".") && importer ? resolve(dirname(importer.split("?")[0]),request) : request.startsWith("~/") ? join(web,"src",request.slice(2)) : request;
        key=key.replace(/\.(tsx?|jsx?)$/,"");
        if(boundaries.has(key)) return "\0composer-boundary:"+key;
        // The fixture lives in scripts; resolve its declared browser dependencies from web.
        if ((importer === join(repo,"scripts/weasel/composer-mobile-fixture.tsx") || importer?.startsWith("\0composer-boundary:")) && !request.startsWith(".") && !request.startsWith("/") && !request.startsWith("\0")) {
          return this.resolve(request, join(web,"src/main.tsx"), {skipSelf:true});
        }
      },
      load(id) {
        if(id.startsWith("\0composer-boundary:")) return boundaries.get(id.slice("\0composer-boundary:".length));
        if(variant==="before" && source[id]) return source[id];
      },
    };
    await writeFile(join(directory,"index.html"),'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
    await writeFile(join(directory,"fixture.css"),`@import ${JSON.stringify(join(web,"src/index.css"))};\n@source ${JSON.stringify(join(web,"src"))};\n@source ${JSON.stringify(join(repo,"scripts/weasel/composer-mobile-fixture.tsx"))};\n`);
    await writeFile(join(directory,"main.tsx"),`import "./fixture.css";import {mountComposerFixture} from ${JSON.stringify(join(repo,"scripts/weasel/composer-mobile-fixture.tsx"))};mountComposerFixture();`);
    const vite = await createServer({configFile:false,root:directory,plugins:[plugin,react(),tailwind()],resolve:{alias:{"~":join(web,"src"),"react-dom":dirname(webRequire.resolve("react-dom/package.json")),"react":dirname(webRequire.resolve("react/package.json"))}},server:{host:"127.0.0.1",port:0,fs:{allow:[repo]}}});
    let browser;
    try {
      await vite.listen();
      const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
      browser=await chromium.launch({headless:true});
      const matrix=[... [360,384,390,412].flatMap(width=>[840,460].flatMap(height=>["default","large"].map(text=>({width,height,text})))),{width:1280,height:900,text:"default"}, {width:360,height:460,text:"large",catalog:"long"}, {width:1280,height:900,text:"default",catalog:"long"}];
      for(const entry of matrix) {
        const name=`composer-${variant}-${entry.width}x${entry.height}-${entry.text}${entry.catalog?"-"+entry.catalog:""}`;
        const page=await browser.newPage({viewport:{width:entry.width,height:entry.height},deviceScaleFactor:1,reducedMotion:"reduce"});
        const errors=[];const forbiddenRequests=[];
        page.on("pageerror",error=>errors.push(error.message.slice(0,2000)));
        await page.route("**/*",route=>{
          const url=new URL(route.request().url());
          if(url.origin!==origin || /^\/(api|ws|oauth)(\/|$)/.test(url.pathname)){forbiddenRequests.push(url.pathname);return route.abort();}
          return route.continue();
        });
        await page.addInitScript(()=>{
          Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:async()=>{window.composerFixture.mediaCalls++;throw Error("Real media forbidden");}}});
          window.RTCPeerConnection=class {constructor(){window.composerFixture.peerCalls++;throw Error("Real peer forbidden");}};
          const NativeWebSocket=window.WebSocket;window.WebSocket=class extends NativeWebSocket {constructor(url,protocol){if(protocol!=="vite-hmr")throw Error("Fixture application websocket forbidden");super(url,protocol);}};
        });
        const result={name,...entry,variant,emulation:true,keyboard:entry.height===460?"reduced-height emulation":"closed",errors,forbiddenRequests};
        cases.push(result);
        result.images=[];
        const settle=()=>page.evaluate(()=>Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>undefined))));
        const capture=async state=>{
          await settle();
          const file=name+(state==="closed"?"":"-"+state)+".png";
          await page.screenshot({path:join(output,file),fullPage:true});
          result.images.push({state,file,sha256:digest(await readFile(join(output,file)))});
        };
        const context=()=>page.evaluate(()=>window.readComposerFixtureContext());
        const boundedVisible=async selector=>page.locator(selector).evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {label:e.getAttribute("aria-label")||e.textContent?.trim(),x:r.x,y:r.y,right:r.right,bottom:r.bottom,inBounds:r.x>=-1&&r.right<=innerWidth+1&&r.y>=-1&&r.bottom<=innerHeight+1};}));
        try {
          await page.goto(`${origin}/?text=${entry.text}&catalog=${entry.catalog??"exact"}`,{timeout:30000});
          await page.getByLabel("Message",{exact:true}).waitFor({timeout:30000});
          await page.evaluate(()=>document.fonts.ready);
          const editor=page.getByLabel("Message",{exact:true});
          await editor.fill("Synthetic mobile draft retained across queue and options");
          await page.getByRole("region",{name:"17 queued messages",exact:true}).waitFor();
          await page.getByRole("button",{name:"Collapse queued messages",exact:true}).click();
          await page.getByRole("button",{name:"Expand queued messages",exact:true}).waitFor();
          await capture("queue-collapsed");
          await page.getByRole("button",{name:"Expand queued messages",exact:true}).click();
          await editor.focus();
          await settle();
          result.geometry=await page.evaluate(()=>{
            const box=element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
            const controls=[...document.querySelectorAll('[data-chat-composer-footer="true"] button,[aria-label="Message"]')].filter(element=>element.getClientRects().length).map(element=>({label:element.getAttribute("aria-label")||element.textContent?.trim(),disabled:element.disabled===true,...box(element)}));
            const queue=document.querySelector('[data-chat-composer-queued-runs] [data-slot="scroll-area-viewport"]');
            if(queue)queue.scrollTop=queue.scrollHeight;
            return {pageWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,viewportHeight:innerHeight,controls,queue:queue?{...box(queue),scrollHeight:queue.scrollHeight,scrollTop:queue.scrollTop}:null,focused:document.activeElement?.getAttribute("aria-label"),reasonVisible:[...document.querySelectorAll('[role="status"]')].some(element=>element.textContent?.includes("has no saved settings"))};
          });
          await page.evaluate(()=>window.scrollTo(0,0));
          await capture("closed");
          await page.getByRole("button",{name:"Record voice message",exact:true}).focus();
          result.micFocusable=await page.getByRole("button",{name:"Record voice message",exact:true}).evaluate(element=>element===document.activeElement);
          const voice=page.getByRole("button",{name:"Start voice call",exact:true});
          result.voiceDisabled=await voice.isDisabled();
          await page.getByRole("button",{name:"Attach files",exact:true}).focus();
          result.attachmentFocusable=await page.getByRole("button",{name:"Attach files",exact:true}).evaluate(element=>element===document.activeElement);
          // The actual link remains reachable without visiting settings or changing credentials.
          const secondary=page.getByRole("link",{name:"Voice provider and API key settings",exact:true});
          await secondary.focus();
          result.secondaryFocusable=await secondary.evaluate(element=>element===document.activeElement);
          if(variant==="after" && entry.width<640) {
            const group=page.getByRole("button",{name:"Model and configuration",exact:true});
            const close=page.getByRole("button",{name:"Close configuration",exact:true});
            const openGroup=async()=>{if(!await close.isVisible()) await group.click();await close.waitFor();};
            const initial=await context();
            const callsBefore=await page.evaluate(()=>JSON.stringify([window.composerFixture.modelChoices,window.composerFixture.runtimeChoices,window.composerFixture.interactionChoices,window.composerFixture.interactionToggles]));
            await openGroup();
            await page.getByRole("button",{name:"Choose model",exact:true}).waitFor();
            await page.getByRole("combobox",{name:"Runtime mode",exact:true}).waitFor();
            const callsAfter=await page.evaluate(()=>JSON.stringify([window.composerFixture.modelChoices,window.composerFixture.runtimeChoices,window.composerFixture.interactionChoices,window.composerFixture.interactionToggles]));
            if(callsBefore!==callsAfter || JSON.stringify(initial)!==JSON.stringify(await context())) throw Error("Configuration open changed selection");
            await settle();
            result.configurationGeometry=await boundedVisible('[data-slot="popover-popup"] button,[data-slot="popover-popup"] [role="combobox"]');
            if(!result.configurationGeometry.length || !result.configurationGeometry.every(item=>item.inBounds)) throw Error("Configuration controls out of bounds");
            await capture("configuration-open");
            // Exercise the existing picker and controlled callbacks, then restore the original model.
            for(const label of ["Synthetic alternate model",entry.catalog==="long"?"GPT-6.1-Sol · synthetic long model and context selection":"GPT-6.1-Sol"]) {
              await openGroup();
              await page.getByRole("button",{name:"Choose model",exact:true}).click();
              await page.getByRole("option").filter({hasText:label}).click();
              result.modelPickerFocus=await page.evaluate(()=>document.activeElement?.getAttribute("aria-label"));
            }
            await openGroup();
            await page.locator('button[data-composer-shortcut="composer.effort"]').click();
            await page.getByRole("menuitemradio",{name:"High",exact:true}).click();
            result.reasoningChoice=await context();
            if(result.reasoningChoice.reasoning!=="high") throw Error("Actual draft reasoning choice missing");
            await openGroup();
            await page.getByRole("combobox",{name:"Runtime mode",exact:true}).click();
            await page.getByRole("option").filter({hasText:"Supervised"}).click();
            if((await context()).runtimeMode!=="approval-required") throw Error("Runtime choice not reflected");
            await openGroup();
            await page.getByRole("button",{name:"Default mode — click to enter plan mode",exact:true}).click();
            if((await context()).interactionMode!=="plan") throw Error("Interaction choice not reflected");
            await capture("configuration-choice");
            await close.click();
            await page.waitForFunction(()=>document.activeElement?.getAttribute("aria-label")==="Model and configuration",null,{timeout:2000});
            result.explicitCloseFocus=await group.evaluate(element=>element===document.activeElement);
            if(!result.explicitCloseFocus) throw Error("Explicit configuration close lost focus");
            await capture("configuration-focus");
            await openGroup();
            await page.getByRole("button",{name:"Plan mode — click to return to normal build mode",exact:true}).waitFor();
            result.retainedChoice=await context();
            if(result.retainedChoice.reasoning!=="high" || result.retainedChoice.runtimeMode!=="approval-required") throw Error("Configuration choice not retained");
            await page.keyboard.press("Escape");
            await close.waitFor({state:"hidden"});
            await page.waitForFunction(()=>document.activeElement?.getAttribute("aria-label")==="Model and configuration",null,{timeout:2000});
            result.escapeCloseFocus=await group.evaluate(element=>element===document.activeElement);
            if(!result.escapeCloseFocus) throw Error("Escape configuration close lost focus");
            result.optionsOpened=true;
          } else {
            const options=page.getByRole("combobox",{name:"Runtime mode",exact:true});
            if(await options.isVisible()) {
              await options.click();
              await page.getByRole("option").filter({hasText:"Full access"}).waitFor();
              result.baselineOptionsRoute="inline-runtime";
            } else {
              await page.getByRole("button",{name:"More composer controls",exact:true}).click();
              await page.getByRole("menuitemradio",{name:"Full access",exact:true}).waitFor();
              result.baselineOptionsRoute="actual-overflow-menu";
            }
            await page.keyboard.press("Escape");result.optionsOpened=true;
          }
          await editor.focus();
          const send=page.getByRole("button",{name:"Submit message",exact:true});
          await send.click();
          result.observation=await page.evaluate(()=>window.composerFixture);
          result.interactionPassed=result.micFocusable&&result.attachmentFocusable&&result.secondaryFocusable&&result.voiceDisabled&&result.observation.sends.length===1&&result.observation.sends[0]==="Synthetic mobile draft retained across queue and options";
          if(variant==="after"&&entry.width<640) {
            const choices=result.observation.modelChoices;
            if(choices.length!==2||choices[0].model!=="synthetic-alternate"||choices[1].model!=="gpt-6.1-sol"||result.observation.runtimeChoices.length!==1||result.observation.runtimeChoices[0]!=="approval-required"||result.observation.interactionToggles!==1) throw Error("Controlled choice callbacks differ");
          }
          result.inBounds=result.geometry.pageWidth<=entry.width&&result.geometry.controls.every(control=>control.x>=-1&&control.right<=entry.width+1&&control.y>=-1&&control.bottom<=entry.height+1);
          result.passiveCallsZero=result.observation.forbiddenCommands===0&&result.observation.mediaCalls===0&&result.observation.peerCalls===0&&forbiddenRequests.length===0;
          if(variant==="after"&&(!result.inBounds||!result.interactionPassed||!result.passiveCallsZero||result.geometry.reasonVisible||!result.geometry.queue||result.geometry.queue.scrollTop<=0||errors.length)) throw Error("Hotfix viewport acceptance failed");
        } catch(error) {
          result.failure=String(error.message).slice(0,2000);
          await capture("failure").catch(()=>{});
          // Baseline geometric failure is expected; inability to mount or interact is a harness failure.
          failure=result.failure;
          throw error;
        } finally {await page.close();}
      }
    } finally {
      await writeFile(join(output,"composer-mobile-receipt.json"),JSON.stringify({scope:"EMULATED actual production composer; no device/native/provider acceptance",baseline,dependencyGraph:baseline,beforeScope:"exact current-main a86 production UI on a86 dependencies; published33 S24 JPG remains separate reference",source:bindings,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,head:process.env.GITHUB_SHA,cases,failure},null,2));
      await browser?.close();await vite.close();await rm(directory,{recursive:true,force:true});
    }
  }
}
