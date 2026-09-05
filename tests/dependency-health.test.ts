import { describe, expect, it } from "vitest";

import { DEVNET_GENESIS_HASH, canonicalHash } from "@uptime402/domain";
import {
  inspectAppliedDependencyRoute,
  type AppliedRouteReader,
} from "../apps/control-plane/src/server/dependency-health.js";

const route = {
  version: "1" as const,
  kind: "firestore_recovery_route" as const,
  activationId: "activation-1",
  incidentId: "incident-1",
  offerId: "offer-1",
  operationId: "operation-1",
  paymentId: "payment-1",
  txSignature: "2".repeat(88),
  resourceUrl: "https://vendor.example/v1/recovery",
  state: "active" as const,
  activatedAt: "2026-08-03T00:00:00.000Z",
  expiresAt: "2026-08-03T00:10:00.000Z",
};

const rpcEvidence = { endpointHash: canonicalHash("endpoint"), responseHash: canonicalHash("response"), genesisHash: DEVNET_GENESIS_HASH, latencyMs: 12 };
const probe = { probe: async () => rpcEvidence };

function reader(value: unknown | null): AppliedRouteReader {
  return { read: async () => value };
}

describe("applied dependency route health", () => {
  it("reports healthy only for the independently read, hash-bound active route", async () => {
    const result = await inspectAppliedDependencyRoute(
      { incidentId: route.incidentId, activationId: route.activationId },
      reader({ schemaVersion: "1", recordHash: canonicalHash(route), value: route }),
      () => "2026-08-03T00:05:00.000Z",
      probe,
    );
    expect(result).toEqual({
      healthy: true,
      body: {
        status: "healthy",
        routeActivationId: "activation-1",
        details: {
          kind: "solana_rpc_probe",
          ...rpcEvidence, observedAt: "2026-08-03T00:05:00.000Z",
          state: "active",
          offerId: "offer-1",
        },
      },
    });
  });

  it("fails closed for missing, mismatched, expired, or tampered routes", async () => {
    const input = { incidentId: route.incidentId, activationId: route.activationId };
    await expect(inspectAppliedDependencyRoute(input, reader(null))).resolves.toEqual({
      healthy: false,
      reason: "route_missing",
    });
    await expect(
      inspectAppliedDependencyRoute(
        input,
        reader({ schemaVersion: "1", recordHash: canonicalHash(route), value: { ...route, activationId: "other" } }),
      ),
    ).rejects.toThrow("canonical hash");
    await expect(
      inspectAppliedDependencyRoute(
        { ...input, activationId: "other" },
        reader({ schemaVersion: "1", recordHash: canonicalHash(route), value: route }),
      ),
    ).resolves.toEqual({ healthy: false, reason: "activation_mismatch" });
    await expect(
      inspectAppliedDependencyRoute(
        input,
        reader({ schemaVersion: "1", recordHash: canonicalHash(route), value: route }),
        () => route.expiresAt,
      ),
    ).resolves.toEqual({ healthy: false, reason: "route_expired" });
  });
});


it("does not report healthy from a route document alone", async () => {
  const input = { incidentId: route.incidentId, activationId: route.activationId };
  const record = reader({ schemaVersion: "1", recordHash: canonicalHash(route), value: route });
  await expect(inspectAppliedDependencyRoute(input, record, () => "2026-08-03T00:05:00.000Z")).resolves.toEqual({ healthy: false, reason: "rpc_probe_unconfigured" });
  await expect(inspectAppliedDependencyRoute(input, record, () => "2026-08-03T00:05:00.000Z", { probe: async () => { throw new Error("RPC unavailable"); } })).rejects.toThrow("RPC unavailable");
});
