import { canonicalHash, canonicalize, DEVNET_GENESIS_HASH, verifyRpcRecoveryProof } from "@uptime402/domain";
import { describe, expect, it } from "vitest";

function fixture() {
  const resource = { version: "1", kind: "firestore_recovery_route", activationId: "a".repeat(64), incidentId: "incident", paymentId: "payment", offerId: "offer", operationId: "operation", txSignature: "2".repeat(88), resourceUrl: "https://vendor.example/v1/recovery", rpcEndpoint: "https://vendor.example/v1/recovery-rpc", state: "active", activatedAt: "2026-10-22T00:00:00Z", expiresAt: "2026-10-22T00:10:00Z" };
  const responses = [{ jsonrpc: "2.0", id: 0, result: "ok" }, { jsonrpc: "2.0", id: 1, result: DEVNET_GENESIS_HASH }];
  const healthProbe = { healthy: true, observedAt: "2026-10-22T00:00:02Z", routeActivationId: resource.activationId, statusCode: 200, latencyMs: 100,
    details: { kind: "solana_rpc_probe", state: "active", offerId: resource.offerId, endpointHash: canonicalHash({ offerId: resource.offerId, resourceUrl: resource.resourceUrl, rpcUrl: resource.rpcEndpoint, authentication: "google-iam" }), responseHash: canonicalHash(responses), genesisHash: DEVNET_GENESIS_HASH, latencyMs: 100, observedAt: "2026-10-22T00:00:01Z", rpcEndpoint: resource.rpcEndpoint, authentication: "google-iam", rpcResponsesJson: canonicalize(responses) } };
  const expected = { ...resource, resourceResponseHash: canonicalHash(resource), healthProbeHash: canonicalHash(healthProbe), fulfilledAt: "2026-10-22T00:00:00Z", recoveredAt: "2026-10-22T00:00:03Z" };
  return { proof: { resource, healthProbe }, expected };
}
describe("receipt-bound RPC recovery proof", () => {
  it("accepts real response shape only when bound to both signed hashes", () => {
    const f = fixture(); expect(verifyRpcRecoveryProof(f.proof, f.expected)).toEqual(f.proof);
  });
  it.each(["endpoint", "payment", "response", "outcome", "expiry", "order"])("rejects changed %s evidence", kind => {
    const f = fixture();
    if (kind === "endpoint") f.proof.resource.rpcEndpoint = "https://attacker.example/rpc";
    if (kind === "payment") f.expected.paymentId = "different";
    if (kind === "response") f.proof.healthProbe.details.rpcResponsesJson = "[]";
    if (kind === "outcome") f.expected.healthProbeHash = canonicalHash({ other: true });
    if (kind === "expiry") f.expected.recoveredAt = f.proof.resource.expiresAt;
    if (kind === "order") f.expected.fulfilledAt = "2026-10-22T00:00:04Z";
    expect(() => verifyRpcRecoveryProof(f.proof, f.expected)).toThrow();
  });
});
