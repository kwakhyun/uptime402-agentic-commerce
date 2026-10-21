import { z } from "zod";
import { canonicalHash } from "./canonical.js";
import { DEVNET_GENESIS_HASH, Sha256Schema, TimestampSchema } from "./schemas.js";
import { parseStrictJson } from "./strict-json.js";

const ProbeSchema = z.object({
  healthy: z.literal(true), observedAt: TimestampSchema, routeActivationId: z.string().min(1),
  statusCode: z.literal(200), latencyMs: z.number().finite().nonnegative(),
  details: z.object({
    kind: z.literal("solana_rpc_probe"), state: z.literal("active"), offerId: z.string(),
    endpointHash: Sha256Schema, responseHash: Sha256Schema, genesisHash: z.literal(DEVNET_GENESIS_HASH),
    latencyMs: z.number().finite().nonnegative(), observedAt: TimestampSchema,
    rpcEndpoint: z.string().url(), authentication: z.literal("google-iam"), rpcResponsesJson: z.string().max(16_384),
  }).strict(),
}).strict();
const ResourceSchema = z.object({
  version: z.literal("1"), kind: z.literal("firestore_recovery_route"), activationId: z.string(),
  incidentId: z.string(), paymentId: z.string(), offerId: z.string(), operationId: z.string(), txSignature: z.string(),
  resourceUrl: z.string().url(), rpcEndpoint: z.string().url(), state: z.literal("active"),
  activatedAt: TimestampSchema, expiresAt: TimestampSchema,
}).strict();
export const RpcRecoveryProofSchema = z.object({ resource: ResourceSchema, healthProbe: ProbeSchema }).strict();

/** The caller first verifies the payment's vendor receipt and control-plane outcome signatures. */
export function verifyRpcRecoveryProof(raw: unknown, expected: {
  incidentId: string; paymentId: string; offerId: string; txSignature: string; resourceResponseHash: string;
  resourceUrl: string; operationId: string; healthProbeHash: string; fulfilledAt: string; recoveredAt: string;
}) {
  const proof = RpcRecoveryProofSchema.parse(raw);
  const { resource, healthProbe: probe } = proof;
  const endpoint = new URL("/v1/recovery-rpc", expected.resourceUrl).href;
  if (canonicalHash(resource) !== expected.resourceResponseHash || canonicalHash(probe) !== expected.healthProbeHash ||
      resource.incidentId !== expected.incidentId || resource.paymentId !== expected.paymentId || resource.offerId !== expected.offerId ||
      resource.txSignature !== expected.txSignature || resource.resourceUrl !== expected.resourceUrl || resource.operationId !== expected.operationId ||
      probe.routeActivationId !== resource.activationId || probe.details.offerId !== resource.offerId ||
      resource.rpcEndpoint !== endpoint || probe.details.rpcEndpoint !== endpoint ||
      canonicalHash({ offerId: expected.offerId, resourceUrl: expected.resourceUrl, rpcUrl: endpoint, authentication: "google-iam" }) !== probe.details.endpointHash) {
    throw new Error("RPC proof is not bound to the paid resource and signed outcome");
  }
  const responses = z.tuple([
    z.object({ jsonrpc: z.literal("2.0"), id: z.literal(0), result: z.literal("ok") }).strict(),
    z.object({ jsonrpc: z.literal("2.0"), id: z.literal(1), result: z.literal(DEVNET_GENESIS_HASH) }).strict(),
  ]).parse(parseStrictJson(probe.details.rpcResponsesJson));
  if (canonicalHash(responses) !== probe.details.responseHash) throw new Error("RPC response hash mismatch");
  const times = [resource.activatedAt, expected.fulfilledAt, probe.details.observedAt, probe.observedAt, expected.recoveredAt].map(Date.parse);
  if (times.some((t, i) => i > 0 && t < times[i - 1]!) || Date.parse(resource.expiresAt) <= times.at(-1)!) {
    throw new Error("RPC proof chronology or access expiry mismatch");
  }
  return proof;
}
