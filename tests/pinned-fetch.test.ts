import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";

import { describe, expect, it } from "vitest";
import { PinnedFacilitatorClient } from "@uptime402/payments";

import {
  createExplicitLocalHttpTestFetchFactory,
  createProductionOriginBoundFetchFactory,
  isPublicInternetAddress,
  type OriginBoundHttpsRequest,
} from "../apps/control-plane/src/server/pinned-fetch.js";

type FakeResponse = Readonly<{
  status?: number;
  headers?: Readonly<Record<string, string>>;
  chunks?: readonly Uint8Array[];
}>;

function fakeHttpsRequest(
  response: FakeResponse,
  captured: RequestOptions[],
): OriginBoundHttpsRequest {
  return (options, onResponse) => {
    captured.push(options);
    const emitter = new EventEmitter();
    let destroyed = false;
    const fake = Object.assign(emitter, {
      end(): void {
        queueMicrotask(() => {
          if (destroyed) return;
          const body = Readable.from(response.chunks ?? [Buffer.from('{"ok":true}')]);
          const headers = response.headers ?? {
            "content-type": "application/json",
            "content-encoding": "identity",
          };
          Object.assign(body, {
            statusCode: response.status ?? 200,
            statusMessage: "OK",
            headers,
          });
          onResponse(body as unknown as IncomingMessage);
        });
      },
      destroy(error?: Error): void {
        destroyed = true;
        if (error) queueMicrotask(() => emitter.emit("error", error));
      },
    });
    return fake as unknown as ClientRequest;
  };
}

function callLookup(
  options: RequestOptions,
): Promise<readonly { address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    if (!options.lookup) {
      reject(new Error("lookup callback missing"));
      return;
    }
    options.lookup(
      String(options.hostname),
      { all: true },
      (error, addresses) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Array.isArray(addresses)) {
          reject(new Error("lookup did not return all addresses"));
          return;
        }
        resolve(addresses);
      },
    );
  });
}

describe("production origin-bound HTTPS fetch", () => {
  it("is the facilitator client's default production egress boundary", async () => {
    const captured: RequestOptions[] = [];
    const body = Buffer.from(JSON.stringify({ kinds: [], extensions: [], signers: {} }));
    const factory = createProductionOriginBoundFetchFactory(
      { resolver: async () => [{ address: "8.8.8.8", family: 4 }] },
      fakeHttpsRequest({ chunks: [body] }, captured),
    );
    const client = new PinnedFacilitatorClient({
      baseUrl: "https://facilitator.example/facilitator",
      pinnedOrigin: "https://facilitator.example",
      originBoundFetchFactory: factory,
    });

    await expect(client.getSupported()).resolves.toEqual({
      kinds: [],
      extensions: [],
      signers: {},
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      hostname: "facilitator.example",
      servername: "facilitator.example",
      path: "/facilitator/supported",
      method: "GET",
    });
    expect(await callLookup(captured[0]!)).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("pins one DNS resolution into the connect-time lookup while preserving host and TLS SNI", async () => {
    let resolverCalls = 0;
    const captured: RequestOptions[] = [];
    const factory = createProductionOriginBoundFetchFactory(
      {
        resolver: async () => {
          resolverCalls += 1;
          return [
            { address: "8.8.8.8", family: 4 },
            { address: "2606:4700:4700::1111", family: 6 },
          ];
        },
      },
      fakeHttpsRequest({}, captured),
    );

    const firstFetch = factory.forOrigin("https://vendor.uptime402.example");
    const secondFetch = factory.forOrigin("https://vendor.uptime402.example");
    await firstFetch("https://vendor.uptime402.example/.well-known/agent-card.json");
    await secondFetch("https://vendor.uptime402.example/a2a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "request-1" }),
    });

    expect(resolverCalls).toBe(1);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      protocol: "https:",
      hostname: "vendor.uptime402.example",
      servername: "vendor.uptime402.example",
      port: 443,
      agent: false,
    });
    expect(captured[0]?.headers).toMatchObject({
      host: "vendor.uptime402.example",
      "accept-encoding": "identity",
    });
    expect(await callLookup(captured[0]!)).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(await callLookup(captured[1]!)).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("rejects the complete resolution if any answer is private, link-local, or metadata-adjacent", async () => {
    const factory = createProductionOriginBoundFetchFactory({
      resolver: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    });
    await expect(factory.forOrigin("https://vendor.uptime402.example")(
      "https://vendor.uptime402.example/a2a",
    )).rejects.toThrow("non-public address");

    expect(() =>
      createProductionOriginBoundFetchFactory().forOrigin("https://metadata.google.internal"),
    ).toThrow("forbidden");
    expect(() =>
      createProductionOriginBoundFetchFactory().forOrigin("https://127.0.0.1"),
    ).toThrow("not a public address");
  });

  it("rejects HTTP, credentials, fragments, cross-origin requests, and duplicate query keys", async () => {
    expect(() =>
      createProductionOriginBoundFetchFactory().forOrigin("http://vendor.example"),
    ).toThrow("https:");
    expect(() =>
      createProductionOriginBoundFetchFactory().forOrigin("https://user@vendor.example"),
    ).toThrow("credentials");

    const fetchImpl = createProductionOriginBoundFetchFactory(
      {
        resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      },
      fakeHttpsRequest({}, []),
    ).forOrigin("https://vendor.example");
    await expect(fetchImpl("https://other.example/a2a")).rejects.toThrow("pinned origin");
    await expect(fetchImpl("https://vendor.example/a2a#secret")).rejects.toThrow("fragment");
    await expect(fetchImpl("https://vendor.example/a2a?k=1&k=2")).rejects.toThrow(
      "Duplicate query key",
    );
  });

  it("rejects redirects, compressed responses, and oversized response streams", async () => {
    const makeFetch = async (response: FakeResponse): Promise<typeof fetch> =>
      createProductionOriginBoundFetchFactory(
        {
          resolver: async () => [{ address: "8.8.8.8", family: 4 }],
          maxResponseBytes: 16,
        },
        fakeHttpsRequest(response, []),
      ).forOrigin("https://vendor.example");

    await expect((await makeFetch({ status: 302 }))("https://vendor.example/a2a")).rejects.toThrow(
      "redirects are forbidden",
    );
    await expect(
      (await makeFetch({ headers: { "content-type": "application/json", "content-encoding": "gzip" } }))(
        "https://vendor.example/a2a",
      ),
    ).rejects.toThrow("non-identity");
    await expect(
      (await makeFetch({ chunks: [Buffer.from('{"payload":"this is too large"}')] }))(
        "https://vendor.example/a2a",
      ),
    ).rejects.toThrow("byte limit");
  });

  it("enforces request bytes and permits the official A2A JSON GET/POST shape", async () => {
    const captured: RequestOptions[] = [];
    const fetchImpl = createProductionOriginBoundFetchFactory(
      {
        resolver: async () => [{ address: "8.8.8.8", family: 4 }],
        maxRequestBytes: 32,
      },
      fakeHttpsRequest({}, captured),
    ).forOrigin("https://vendor.example");

    const card = await fetchImpl("https://vendor.example/.well-known/agent-card.json");
    expect(await card.json()).toEqual({ ok: true });
    const rpc = await fetchImpl("https://vendor.example/a2a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(await rpc.json()).toEqual({ ok: true });
    expect(captured[1]?.headers).toMatchObject({
      "content-length": "17",
      "content-type": "application/json",
    });

    await expect(
      fetchImpl("https://vendor.example/a2a", {
        method: "POST",
        body: "x".repeat(33),
      }),
    ).rejects.toThrow("request exceeds");
  });
});

describe("explicit local HTTP test factory", () => {
  it("permits only an injected loopback test origin and applies response guards", async () => {
    const delegated: string[] = [];
    const localFetch: typeof fetch = async (input) => {
      delegated.push(input instanceof URL ? input.toString() : String(input));
      return new Response('{"kind":"agent-card"}', {
        status: 200,
        headers: { "content-type": "application/json", "content-encoding": "identity" },
      });
    };
    const factory = createExplicitLocalHttpTestFetchFactory({
      fetchImpl: localFetch,
    });
    const fetchImpl = factory.forOrigin("http://127.0.0.1:4187");

    expect(await (await fetchImpl("http://127.0.0.1:4187/card")).json()).toEqual({
      kind: "agent-card",
    });
    expect(delegated).toEqual(["http://127.0.0.1:4187/card"]);
    await expect(fetchImpl("http://127.0.0.1:4188/card")).rejects.toThrow("pinned origin");
    expect(() =>
      factory.forOrigin("http://10.0.0.8:4187"),
    ).toThrow("loopback");
  });
});

describe("public address classification", () => {
  it.each([
    ["8.8.8.8", true],
    ["10.0.0.1", false],
    ["169.254.169.254", false],
    ["224.0.0.1", false],
    ["2606:4700:4700::1111", true],
    ["::1", false],
    ["fe80::1", false],
    ["fc00::1", false],
    ["ff02::1", false],
    ["2001:db8::1", false],
  ])("classifies %s as public=%s", (address, expected) => {
    expect(isPublicInternetAddress(address)).toBe(expected);
  });
});
