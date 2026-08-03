import {
  IncidentSchema,
  canonicalHash,
  type Incident,
} from "@uptime402/domain";
import { z } from "zod";

import {
  FirestoreDataIntegrityError,
  ImmutableRecordConflictError,
  type FirestoreTransactionalRepository,
  type ImmutablePutResult,
} from "./firestore.js";

const Sha256IdentifierSchema = z.custom<`sha256:${string}`>(
  (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value),
  "Expected a lowercase SHA-256 identifier",
);

export const RuntimeOperationRecordSchema = z
  .object({
    id: z.string().min(1).max(128),
    requiredCapability: z.string().min(1).max(128),
    subject: z.string().min(1).max(256),
    request: z
      .object({
        method: z.enum(["GET", "POST"]),
        resourceUrl: z.string().url(),
        operationId: z.string().min(1).max(128),
        canonicalBodyHash: Sha256IdentifierSchema,
      })
      .strict(),
  })
  .strict()
  .refine((value) => value.id === value.request.operationId, {
    message: "Operation ID must match the authoritative request operation ID",
    path: ["request", "operationId"],
  });

export type RuntimeOperationRecord = z.infer<typeof RuntimeOperationRecordSchema>;

const envelopeSchema = z
  .object({
    schemaVersion: z.literal("1"),
    recordHash: Sha256IdentifierSchema,
    value: z.unknown(),
  })
  .strict();

/**
 * Shared control-plane -> executor handoff for immutable incident and request
 * state. Mutable money state remains owned by the private executor routes.
 */
export class FirestoreRuntimeStateRepository {
  constructor(readonly repository: FirestoreTransactionalRepository) {}

  private collection(suffix: "incidents" | "operations") {
    return this.repository.firestore.collection(`${this.repository.collectionPrefix}_${suffix}`);
  }

  private async putImmutable<T>(
    suffix: "incidents" | "operations",
    id: string,
    value: T,
  ): Promise<ImmutablePutResult<T>> {
    const reference = this.collection(suffix).doc(id);
    const hash = canonicalHash(value);
    return this.repository.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists) {
        const envelope = envelopeSchema.parse(snapshot.data());
        if (canonicalHash(envelope.value) !== envelope.recordHash) {
          throw new FirestoreDataIntegrityError(`Canonical runtime-state hash mismatch at ${reference.path}`);
        }
        if (envelope.recordHash !== hash) {
          throw new ImmutableRecordConflictError(reference.parent.path, id);
        }
        return { kind: "existing", record: structuredClone(value) };
      }
      transaction.create(reference, { schemaVersion: "1", recordHash: hash, value });
      return { kind: "stored", record: structuredClone(value) };
    }, { maxAttempts: this.repository.transactionMaxAttempts });
  }

  private async getImmutable<T>(
    suffix: "incidents" | "operations",
    id: string,
    parse: (value: unknown) => T,
  ): Promise<T | null> {
    const snapshot = await this.collection(suffix).doc(id).get();
    if (!snapshot.exists) return null;
    const envelope = envelopeSchema.parse(snapshot.data());
    if (canonicalHash(envelope.value) !== envelope.recordHash) {
      throw new FirestoreDataIntegrityError(`Canonical runtime-state hash mismatch at ${snapshot.ref.path}`);
    }
    return structuredClone(parse(envelope.value));
  }

  async putIncident(value: Incident): Promise<ImmutablePutResult<Incident>> {
    const parsed = IncidentSchema.parse(value);
    return this.putImmutable("incidents", parsed.id, parsed);
  }

  async getIncident(incidentId: string): Promise<Incident | null> {
    return this.getImmutable("incidents", incidentId, (value) => IncidentSchema.parse(value));
  }

  async putOperation(
    value: RuntimeOperationRecord,
  ): Promise<ImmutablePutResult<RuntimeOperationRecord>> {
    const parsed = RuntimeOperationRecordSchema.parse(value);
    return this.putImmutable("operations", parsed.id, parsed);
  }

  async getOperation(operationId: string): Promise<RuntimeOperationRecord | null> {
    return this.getImmutable("operations", operationId, (value) =>
      RuntimeOperationRecordSchema.parse(value));
  }
}
