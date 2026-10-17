import { describe, expect, it, vi } from "vite-plus/test";
import type { Connect, ViteDevServer } from "vite-plus";
import { localDevLoginPlugin } from "../vite/localDevLogin";

async function run(
  options: {
    enabled?: boolean;
    host?: string;
    backend?: string;
    remote?: string;
    headers?: Record<string, string>;
    exchangeStatus?: number;
  } = {},
) {
  const cookieHeaders = new Headers();
  cookieHeaders.append(
    "set-cookie",
    "t3_dev_session_fixture=fixture; HttpOnly; Path=/; SameSite=Lax",
  );
  cookieHeaders.append("set-cookie", "t3_session_previous=; Max-Age=0; HttpOnly; Path=/");
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response("{}", {
        status: options.exchangeStatus ?? 200,
        headers: cookieHeaders,
      }),
    )
    .mockResolvedValueOnce(Response.json({ authenticated: true, auth: { mode: "required" } }));
  const plugin = localDevLoginPlugin({
    enabled: options.enabled ?? true,
    credential: "private-config-fixture",
    backend: options.backend ?? "http://localhost:3780",
    fetch,
  });
  let middleware: Connect.NextHandleFunction | undefined;
  const configure = plugin.configureServer as (server: ViteDevServer) => void;
  configure({
    config: { server: { host: options.host ?? "localhost", port: 7058 } },
    middlewares: {
      use: (handler: Connect.NextHandleFunction) => {
        middleware = handler;
      },
    },
  } as unknown as ViteDevServer);
  const writeHead = vi.fn();
  const end = vi.fn();
  const next = vi.fn();
  if (middleware) {
    await new Promise<void>((resolve) => {
      const request = {
        method: "GET",
        url: "/api/auth/session",
        socket: { remoteAddress: options.remote ?? "::1" },
        headers: {
          host: "localhost:7058",
          "sec-fetch-site": "same-origin",
          referer: "http://localhost:7058/",
          ...options.headers,
        },
      } as unknown as Parameters<Connect.NextHandleFunction>[0];
      middleware!(
        request,
        {
          writeHead,
          end: (body: string) => {
            end(body);
            resolve();
          },
        } as unknown as Parameters<Connect.NextHandleFunction>[1],
        () => {
          next();
          resolve();
        },
      );
    });
  }
  return { fetch, writeHead, end, next, plugin };
}

describe("local dev automatic login", () => {
  it("uses the backend exchange and returns its HttpOnly cookie without exposing the credential", async () => {
    const result = await run();
    expect(result.fetch).toHaveBeenCalledTimes(2);
    expect(result.fetch.mock.calls[0]![0].toString()).toBe(
      "http://localhost:3780/api/auth/browser-session",
    );
    expect(result.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "cache-control": "no-store",
        "set-cookie": expect.arrayContaining([expect.stringContaining("HttpOnly")]),
      }),
    );
    expect(JSON.parse(result.end.mock.calls[0]![0])).toMatchObject({ authenticated: true });
    expect(result.end.mock.calls[0]![0]).not.toContain("private-config-fixture");
    expect(result.plugin.apply).toBe("serve");
    expect(result.fetch.mock.calls[1]![1]?.headers).toMatchObject({
      cookie: "t3_dev_session_fixture=fixture",
    });
  });

  it.each([
    { enabled: false },
    { host: "0.0.0.0" },
    { backend: "https://remote.example" },
    { remote: "100.64.0.1" },
    { headers: { host: "evil.example:7058" } },
    { headers: { origin: "https://evil.example" } },
    { headers: { "sec-fetch-site": "cross-site" } },
    { headers: { cookie: "t3_session_existing=revoked" } },
    { headers: { authorization: "Bearer rejected-grant" } },
  ])("leaves ordinary authentication in place for %j", async (options) => {
    const result = await run(options);
    expect(result.fetch).not.toHaveBeenCalled();
    expect(result.writeHead).not.toHaveBeenCalled();
  });

  it("keeps the pairing fallback when the configured grant is rejected", async () => {
    const result = await run({ exchangeStatus: 401 });
    expect(result.fetch).toHaveBeenCalledTimes(1);
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.writeHead).not.toHaveBeenCalled();
  });
});
