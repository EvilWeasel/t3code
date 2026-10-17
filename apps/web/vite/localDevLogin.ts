import type { Plugin, Connect } from "vite-plus";

const isLoopback = (host: string) =>
  ["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"].includes(host);

/** Opt-in, loopback-only dev convenience. Credentials stay in the Vite process;
 * the backend issues its normal HttpOnly cookie through its existing exchange.
 */
export function localDevLoginPlugin(input: {
  enabled: boolean;
  credential: string | undefined;
  backend: string | undefined;
  fetch?: typeof globalThis.fetch;
}): Plugin {
  return {
    name: "t3-local-dev-login",
    apply: "serve",
    configureServer(server) {
      if (!input.enabled || !input.credential || !input.backend) return;
      const backend = new URL(input.backend);
      if (!isLoopback(backend.hostname) || !isLoopback(String(server.config.server.host))) return;
      const fetch = input.fetch ?? globalThis.fetch;
      const middleware = async (
        ...[request, response, next]: Parameters<Connect.NextHandleFunction>
      ) => {
        if (request.method !== "GET" || request.url !== "/api/auth/session") return next();
        // Existing grants, including rejected/revoked ones, retain precedence.
        if (
          request.headers.authorization ||
          /(?:^|;\s*)t3_[^=]*=/.test(request.headers.cookie ?? "")
        )
          return next();
        try {
          if (!isLoopback(request.socket.remoteAddress ?? "")) return next();
          const origin = new URL(`http://${request.headers.host}`);
          if (!isLoopback(origin.hostname) || origin.port !== String(server.config.server.port))
            return next();
          if (request.headers["sec-fetch-site"] !== "same-origin") return next();
          const referringOrigin = request.headers.origin ?? request.headers.referer;
          if (
            typeof referringOrigin !== "string" ||
            new URL(referringOrigin).origin !== origin.origin
          )
            return next();
          const headers = { origin: origin.origin, "content-type": "application/json" };
          const exchanged = await fetch(new URL("/api/auth/browser-session", backend), {
            method: "POST",
            headers,
            body: JSON.stringify({ credential: input.credential }),
            signal: AbortSignal.timeout(5_000),
          });
          if (!exchanged.ok) return next();
          const cookies = exchanged.headers.getSetCookie();
          if (cookies.length === 0) return next();
          const session = await fetch(new URL("/api/auth/session", backend), {
            headers: {
              origin: origin.origin,
              cookie: cookies
                .map((cookie) => cookie.split(";", 1)[0]!)
                .filter((cookie) => cookie.slice(cookie.indexOf("=") + 1).length > 0)
                .join("; "),
            },
            signal: AbortSignal.timeout(5_000),
          });
          if (!session.ok) return next();
          const state: unknown = await session.json();
          if (
            typeof state !== "object" ||
            state === null ||
            !("authenticated" in state) ||
            state.authenticated !== true
          )
            return next();
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
            "set-cookie": cookies,
          });
          response.end(JSON.stringify(state));
        } catch {
          // Normal auth UI remains the fallback; never log credentials or cookies.
          next();
        }
      };
      server.middlewares.use((request, response, next) => {
        void middleware(request, response, next).catch(next);
      });
    },
  };
}
