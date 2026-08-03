import "server-only";

import {
  IdentifierSchema,
  Sha256Schema,
  canonicalHash,
} from "@uptime402/domain";
import {
  createFirestoreTransactionalRepository,
  type FirestoreTransactionalRepository,
} from "@uptime402/persistence";
import { z } from "zod";

import { FirestoreRecoveryRouteSchema } from "./live-flow.js";

const StoredRouteSchema = z
  .object({
    schemaVersion: z.literal("1"),
    recordHash: Sha256Schema,
    value: FirestoreRecoveryRouteSchema,
  })
  .strict();

const DependencyHealthInputSchema = z
  .object({
    incidentId: IdentifierSchema,
    activationId: z.string().min(1).max(128),
  })
  .strict();

export type AppliedRouteReader = Readonly<{
  read(incidentId: string): Promise<unknown | null>;
}>;

export type DependencyRouteHealth =
  | Readonly<{
      healthy: true;
      body: {
        status: "healthy";
        routeActivationId: string;
        details: {
          kind: "firestore_recovery_route";
          state: "active";
          offerId: string;
        };
      };
    }>
  | Readonly<{
      healthy: false;
      reason: "route_missing" | "activation_mismatch" | "route_expired";
    }>;

/**
 * Reads the dependency route through an independent repository operation and
 * verifies its canonical hash, activation binding, and TTL before reporting
 * healthy. It never treats the vendor's fulfillment claim alone as health.
 */
export async function inspectAppliedDependencyRoute(
  rawInput: unknown,
  reader: AppliedRouteReader,
  now: () => string = () => new Date().toISOString(),
): Promise<DependencyRouteHealth> {
  const input = DependencyHealthInputSchema.parse(rawInput);
  const rawRecord = await reader.read(input.incidentId);
  if (rawRecord === null) return { healthy: false, reason: "route_missing" };

  const record = StoredRouteSchema.parse(rawRecord);
  if (record.recordHash !== canonicalHash(record.value)) {
    throw new Error("Applied dependency route failed its canonical hash check");
  }
  if (
    record.value.incidentId !== input.incidentId ||
    record.value.activationId !== input.activationId
  ) {
    return { healthy: false, reason: "activation_mismatch" };
  }
  if (Date.parse(record.value.expiresAt) <= Date.parse(now())) {
    return { healthy: false, reason: "route_expired" };
  }

  return {
    healthy: true,
    body: {
      status: "healthy",
      routeActivationId: record.value.activationId,
      details: {
        kind: "firestore_recovery_route",
        state: "active",
        offerId: record.value.offerId,
      },
    },
  };
}

export class FirestoreAppliedRouteReader implements AppliedRouteReader {
  constructor(private readonly repository: FirestoreTransactionalRepository) {}

  async read(incidentId: string): Promise<unknown | null> {
    const snapshot = await this.repository.firestore
      .collection(`${this.repository.collectionPrefix}_dependency_routes`)
      .doc(incidentId)
      .get();
    return snapshot.exists ? snapshot.data() ?? null : null;
  }
}

function required(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function buildFirestoreAppliedRouteReader(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): FirestoreAppliedRouteReader {
  if (environment.NODE_ENV === "production" && environment.FIRESTORE_EMULATOR_HOST?.trim()) {
    throw new Error("Production dependency health refuses FIRESTORE_EMULATOR_HOST");
  }
  const collectionPrefix = required(environment, "FIRESTORE_COLLECTION_PREFIX");
  if (!/^[a-z][a-z0-9_-]{0,47}$/u.test(collectionPrefix)) {
    throw new TypeError("FIRESTORE_COLLECTION_PREFIX is invalid");
  }
  return new FirestoreAppliedRouteReader(
    createFirestoreTransactionalRepository(
      {
        projectId: required(environment, "FIRESTORE_PROJECT_ID"),
        databaseId: environment.FIRESTORE_DATABASE_ID?.trim() || "(default)",
      },
      { collectionPrefix },
    ),
  );
}
