import { DEVNET_GENESIS_HASH } from "@uptime402/domain";
import { describe, expect, it, vi } from "vitest";
import { PinnedRecoveryRpcProbe, buildRecoveryRpcProbe } from "../apps/control-plane/src/server/recovery-rpc-probe.js";
import type { FirestoreRecoveryRoute } from "../apps/control-plane/src/server/live-flow-contracts.js";
import type { OriginBoundFetchFactory } from "../apps/control-plane/src/server/pinned-fetch.js";

const route: FirestoreRecoveryRoute = {
  version: "1", kind: "firestore_recovery_route", activationId: "activation-1",
  incidentId: "incident-1", offerId: "offer-1", operationId: "operation-1", paymentId: "payment-1",
  txSignature: "2".repeat(88), resourceUrl: "https://vendor.example/recovery", state: "active",
  activatedAt: "2026-09-05T00:00:00Z", expiresAt: "2026-09-05T00:10:00Z",
};
const routes = [{ offerId: route.offerId, resourceUrl: route.resourceUrl, rpcUrl: "https://recovery-rpc.example/solana" }];

function fixture(health = "ok", genesis: string = DEVNET_GENESIS_HASH) {
  const calls: string[] = [];
  const factory: OriginBoundFetchFactory = {
    mode: "production-pinned-https",
    forOrigin(origin) {
      expect(origin).toBe("https://recovery-rpc.example");
      return async (url, init) => {
        expect(String(url)).toBe(routes[0]!.rpcUrl);
        expect(init?.redirect).toBe("error");
        const body = JSON.parse(String(init?.body));
        calls.push(body.method);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "getHealth" ? health : genesis });
      };
    },
  };
  return { calls, probe: new PinnedRecoveryRpcProbe(routes, factory) };
}

describe("paid route RPC health proof", () => {
  it("uses audience-bound IAM and the receipt-bound endpoint without recording credentials", async () => {
    const getToken = vi.fn(async () => "private-token");
    const requests: RequestInit[] = [];
    const factory: OriginBoundFetchFactory = { mode: "production-pinned-https", forOrigin: () => async (_url, init) => {
      requests.push(init!); const body = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.id === 0 ? "ok" : DEVNET_GENESIS_HASH });
    } };
    const probe = new PinnedRecoveryRpcProbe([{ ...routes[0], authentication: "google-iam" }], factory, getToken);
    await expect(probe.probe(route)).rejects.toThrow("endpoint");
    expect(getToken).not.toHaveBeenCalled();
    const result = await probe.probe({ ...route, rpcEndpoint: routes[0]!.rpcUrl });
    expect(getToken).toHaveBeenCalledWith("https://recovery-rpc.example");
    expect(requests[0]!.headers).toMatchObject({ authorization: "Bearer private-token", "x-uptime402-route-activation": route.activationId });
    expect(result).toMatchObject({ rpcEndpoint: routes[0]!.rpcUrl, authentication: "google-iam" });
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(JSON.parse(result.rpcResponsesJson!)).toHaveLength(2);
  });
  it("probes health and Devnet identity through the configured paid route", async () => {
    const { calls, probe } = fixture();
    expect(await probe.probe(route)).toMatchObject({ genesisHash: DEVNET_GENESIS_HASH, endpointHash: expect.stringMatching(/^sha256:/), responseHash: expect.stringMatching(/^sha256:/) });
    expect(calls.sort()).toEqual(["getGenesisHash", "getHealth"]);
  });
  it("rejects unavailable, wrong-network, and unbound RPC routes", async () => {
    await expect(fixture("behind").probe.probe(route)).rejects.toThrow("health or network");
    await expect(fixture("ok", "mainnet-genesis").probe.probe(route)).rejects.toThrow("health or network");
    const { calls, probe } = fixture();
    await expect(probe.probe({ ...route, offerId: "unpaid-offer" })).rejects.toThrow("no configured RPC");
    expect(calls).toHaveLength(0);
    expect(() => buildRecoveryRpcProbe({ NODE_ENV: "test" })).toThrow("RECOVERY_RPC_ROUTES_JSON");
  });
});
