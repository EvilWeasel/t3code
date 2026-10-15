/* Every browser API below is the real Electron implementation. No shims. */
const workerNonce = crypto.randomUUID();
const outcomes = {};
const events = [];
const report = (payload) =>
  fetch("__REPORT_ORIGIN__/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, workerNonce }),
  });
const attempt = async (name, operation) => {
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Probe call deadline exceeded")), 3000);
      }),
    ]);
    return (outcomes[name] = { status: "supported", evidence: value ?? null });
  } catch (error) {
    return (outcomes[name] = {
      status: String(error).includes("deadline exceeded") ? "unknown" : "unsupported",
      error: String(error).slice(0, 240),
    });
  } finally {
    clearTimeout(timer);
  }
};
const register = (name, source) =>
  attempt(name, () => {
    const listener = (...args) => {
      events.push({ name, args });
    };
    source().addListener(listener);
    return "listener registered; delivery is reported separately";
  });
const baseProbe = async () => {
  await attempt("runtime.getManifest", () => chrome.runtime.getManifest().manifest_version);
  await attempt("storage.local", async () => {
    await chrome.storage.local.set({ probe: workerNonce });
    return (await chrome.storage.local.get("probe")).probe === workerNonce;
  });
  await attempt("storage.session", async () => {
    await chrome.storage.session.set({ probe: workerNonce });
    return (await chrome.storage.session.get("probe")).probe === workerNonce;
  });
  await attempt("alarms.create/get/clear", async () => {
    await chrome.alarms.create("synthetic", { when: Date.now() + 60000 });
    const alarm = await chrome.alarms.get("synthetic");
    await chrome.alarms.clear("synthetic");
    return alarm?.name === "synthetic";
  });
  await register("alarms.onAlarm", () => chrome.alarms.onAlarm);
  await register("permissions.onAdded", () => chrome.permissions.onAdded);
  await register("permissions.onRemoved", () => chrome.permissions.onRemoved);
  await attempt("permissions.contains", () =>
    chrome.permissions.contains({ permissions: ["storage"] }),
  );
  await register("runtime.onMessageExternal", () => chrome.runtime.onMessageExternal);
  await register("runtime.onUpdateAvailable", () => chrome.runtime.onUpdateAvailable);
  await register("commands.onCommand", () => chrome.commands.onCommand);
  await register("tabs.onUpdated", () => chrome.tabs.onUpdated);
  await register("tabs.onRemoved", () => chrome.tabs.onRemoved);
  await register("webRequest.onCompleted", () => ({
    addListener: (listener) =>
      chrome.webRequest.onCompleted.addListener(listener, { urls: ["http://127.0.0.1/*"] }),
  }));
  await attempt("offscreen.createDocument/closeDocument", async () => {
    await chrome.offscreen.createDocument({
      url: "popup.html",
      reasons: ["DOM_PARSER"],
      justification: "Owned synthetic API probe, no clipboard access",
    });
    await chrome.offscreen.closeDocument();
    return true;
  });
  return outcomes;
};
void attempt("runtime.onConnect", () => {
  chrome.runtime.onConnect.addListener((port) => {
    const sender = port.sender;
    port.onMessage.addListener(() => {
      void report({
        type: "port",
        sender: {
          tabId: sender?.tab?.id ?? null,
          frameId: sender?.frameId ?? null,
          url: sender?.url ?? null,
        },
      });
      port.postMessage({ synthetic: true });
    });
  });
  return "real listener registered; delivery reported separately";
});
let base;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handle = async () => {
    if (message.type === "content-probe") {
      await report({
        type: "content",
        requestId: message.requestId,
        href: message.href,
        sender: {
          tabId: sender.tab?.id ?? null,
          frameId: sender.frameId ?? null,
          url: sender.url ?? null,
          origin: sender.origin ?? null,
        },
      });
      return true;
    }
    if (message.type === "base-probe")
      return { workerNonce, outcomes: await (base ??= baseProbe()) };
    if (message.type === "profile-set") {
      await chrome.storage.local.set({ profileMarker: message.marker });
      return workerNonce;
    }
    if (message.type === "profile-get")
      return {
        workerNonce,
        marker: (await chrome.storage.local.get("profileMarker")).profileMarker ?? null,
      };
    if (message.type === "tab-probe") {
      const tabId = message.tabId;
      const result = {};
      const probe = async (name, fn) => (result[name] = await attempt(name, fn));
      await probe("tabs.get", () => chrome.tabs.get(tabId));
      await probe("tabs.query", () => chrome.tabs.query({}));
      await probe("tabs.query.active", () => chrome.tabs.query({ active: true }));
      await probe("tabs.update.muted", () => chrome.tabs.update(tabId, { muted: false }));
      await probe("webNavigation.getFrame", () =>
        chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
      );
      await probe("webNavigation.getAllFrames", () => chrome.webNavigation.getAllFrames({ tabId }));
      await probe("scripting.executeScript", () =>
        chrome.scripting.executeScript({ target: { tabId }, func: () => location.origin }),
      );
      await probe("tabs.sendMessage", () =>
        chrome.tabs.sendMessage(tabId, { type: "roundtrip" }, { frameId: 0 }),
      );
      await probe("action.getPopup", () => chrome.action.getPopup({ tabId }));
      return result;
    }
    if (message.type === "create-tab")
      return attempt("tabs.create", () => chrome.tabs.create({ url: message.url, active: false }));
    if (message.type === "events") return events;
    throw new Error("Unknown synthetic message");
  };
  handle().then(respond, (error) => respond({ probeError: String(error).slice(0, 240) }));
  return true;
});
void report({ type: "worker-boot" }).catch(() => {});
