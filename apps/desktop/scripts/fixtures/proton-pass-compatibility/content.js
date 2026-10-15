/* Synthetic content script: metadata only, never reads or fills any input. */
const send = (requestId) => {
  chrome.runtime
    .sendMessage({ type: "content-probe", requestId, href: location.href })
    .catch((error) =>
      fetch("__REPORT_ORIGIN__/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "content-error",
          requestId,
          href: location.href,
          error: String(error).slice(0, 240),
        }),
      }),
    );
};
window.addEventListener("message", (event) => {
  if (
    event.source === window &&
    event.origin === location.origin &&
    event.data?.type === "morrowbyte-probe"
  )
    send(event.data.requestId);
});
send("initial");
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "roundtrip")
    respond({ href: location.href, frame: window === window.top ? "main" : "child" });
});

try {
  const port = chrome.runtime.connect({ name: "synthetic-proton-api-probe" });
  port.onMessage.addListener(() => port.disconnect());
  port.postMessage({ synthetic: true });
} catch {
  /* Real port failures remain visible as missing delivery evidence. */
}
