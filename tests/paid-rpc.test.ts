import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalHash, canonicalize, DEVNET_GENESIS_HASH, type VendorOffer } from "@uptime402/domain";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";
import { executePaidRpc, PaidRpcRequestSchema } from "../services/vendor-agent/src/paid-rpc.js";
import type { VendorAgentDependencies } from "../services/vendor-agent/src/index.js";

const history = JSON.parse(readFileSync(new URL("../artifacts/payment-evidence.json", import.meta.url), "utf8"));
const offer = history.offers[0] as VendorOffer;
const now = "2026-10-22T00:00:00Z";
function fixture() {
  const key = generateKeyPairSync("ed25519");
  const publicKey = bs58.encode(key.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const origin = new URL(offer.payload.resourceUrl).origin;
  const route = { version: "1", kind: "firestore_recovery_route", activationId: "a".repeat(64),
    incidentId: "rpc-incident", offerId: offer.payload.offerId, operationId: "rpc-operation", paymentId: "rpc-payment-0001",
    txSignature: history.payments[0].txSignature, resourceUrl: offer.payload.resourceUrl, rpcEndpoint: `${origin}/v1/recovery-rpc`,
    state: "active", activatedAt: now, expiresAt: "2026-10-22T00:10:00Z" };
  const payload = { ...history.payments[0].fulfillmentReceipt.payload,
    incidentId: route.incidentId, paymentId: route.paymentId, resourceResponseHash: canonicalHash(route) };
  const receipt = { payload, signer: publicKey, keyId: "rpc-test-key", signature: bs58.encode(sign(null, Buffer.from(canonicalize(payload)), key.privateKey)) };
  const record = { schemaVersion: "1", recordHash: canonicalHash(route), value: route };
  const claim = { state: "receipt_signed", paymentId: route.paymentId, txSignature: route.txSignature,
    resourceResponseHash: record.recordHash, fulfillmentReceipt: receipt };
  const readActivation = vi.fn(async (): Promise<unknown | null> => record);
  const getClaim = vi.fn(async () => claim);
  const call = vi.fn(async (method: string): Promise<string> => method === "getHealth" ? "ok" : DEVNET_GENESIS_HASH);
  // Only the dependency surfaces used by this read-only boundary are supplied.
  const deps = { config: { agentOrigin: origin, vendorTenant: "vendor", offers: [offer], expectedPayerPublicKey: payload.payer },
    claims: { getVendorPaymentClaim: getClaim }, receiptSigner: { signerPublicKey: publicKey, keyId: receipt.keyId },
    paidRpc: { readActivation, call }, now: () => now } as unknown as VendorAgentDependencies;
  return { deps, record, claim, call, readActivation };
}
const input = PaidRpcRequestSchema.parse({ jsonrpc: "2.0", id: 0, method: "getHealth" });

describe("paid Devnet RPC delivery boundary", () => {
  it("calls the real adapter only after a signed paid receipt binds the delivered endpoint", async () => {
    const f = fixture();
    expect(await executePaidRpc(f.deps, f.record.value.activationId, input)).toEqual({ status: 200, body: { jsonrpc: "2.0", id: 0, result: "ok" } });
    expect(await executePaidRpc(f.deps, f.record.value.activationId, { ...input, method: "getGenesisHash" })).toMatchObject({ status: 200, body: { result: DEVNET_GENESIS_HASH } });
    expect(f.call.mock.calls.map(args => args[0])).toEqual(["getHealth", "getGenesisHash"]);
  });
  it("denies an unpaid or incomplete activation without an upstream call", async () => {
    const f = fixture(); f.readActivation.mockResolvedValueOnce(null);
    expect(await executePaidRpc(f.deps, "a".repeat(64), input)).toMatchObject({ status: 402 });
    f.claim.state = "settlement_verified";
    expect(await executePaidRpc(f.deps, "a".repeat(64), input)).toMatchObject({ status: 402 });
    expect(f.call).not.toHaveBeenCalled();
  });
  it("denies expired access before an upstream call", async () => {
    const f = fixture(); f.deps.now = () => "2026-10-22T00:10:00Z";
    expect(await executePaidRpc(f.deps, "a".repeat(64), input)).toMatchObject({ status: 410 });
    expect(f.call).not.toHaveBeenCalled();
  });
  it.each(["endpoint", "receipt", "transaction", "payment"])("rejects a changed %s binding", async kind => {
    const f = fixture();
    if (kind === "endpoint") f.record.value.rpcEndpoint = "https://attacker.example/rpc";
    if (kind === "receipt") f.claim.fulfillmentReceipt.signature = bs58.encode(Buffer.alloc(64));
    if (kind === "transaction") f.claim.txSignature = "2".repeat(88);
    if (kind === "payment") f.claim.paymentId = "other-payment";
    await expect(executePaidRpc(f.deps, "a".repeat(64), input)).rejects.toThrow();
    expect(f.call).not.toHaveBeenCalled();
  });
  it("fails closed on wrong-network upstream responses and disallows arbitrary RPC methods", async () => {
    const f = fixture(); f.call.mockResolvedValue("mainnet");
    await expect(executePaidRpc(f.deps, "a".repeat(64), { ...input, method: "getGenesisHash" })).rejects.toThrow("wrong network");
    expect(PaidRpcRequestSchema.safeParse({ ...input, method: "sendTransaction", params: ["payload"] }).success).toBe(false);
  });
});
