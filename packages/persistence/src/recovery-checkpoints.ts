import {
  IdentifierSchema,
  Sha256Schema,
  canonicalHash,
  canonicalize,
  type JsonValue,
} from "@uptime402/domain";
import type { Firestore } from "@google-cloud/firestore";

export type RecoveryCheckpointStage = "input" | "proof" | "result";
export type RecoveryCheckpoint = { contextHash: string; value: JsonValue };

/** Private continuation data. Never contains payer keys; never returned by public routes. */
export interface RecoveryCheckpointStore {
  get(reservationId: string, stage: RecoveryCheckpointStage): Promise<RecoveryCheckpoint | null>;
  putOnce(reservationId: string, stage: RecoveryCheckpointStage, record: RecoveryCheckpoint): Promise<RecoveryCheckpoint>;
}

function key(reservationId: string, stage: RecoveryCheckpointStage): string {
  IdentifierSchema.parse(reservationId);
  return canonicalHash({ reservationId, stage }).slice(7);
}

function validated(record: RecoveryCheckpoint): RecoveryCheckpoint {
  Sha256Schema.parse(record.contextHash);
  if (Buffer.byteLength(canonicalize(record)) > 800_000) throw new Error("Recovery checkpoint exceeds storage limit");
  return structuredClone(record);
}

function existingOrNew(existing: RecoveryCheckpoint | null, record: RecoveryCheckpoint): RecoveryCheckpoint {
  if (existing && existing.contextHash !== record.contextHash) throw new Error("Recovery checkpoint context conflict");
  return validated(existing ?? record);
}

export class InMemoryRecoveryCheckpointStore implements RecoveryCheckpointStore {
  private readonly records = new Map<string, RecoveryCheckpoint>();
  async get(reservationId: string, stage: RecoveryCheckpointStage) {
    return structuredClone(this.records.get(key(reservationId, stage)) ?? null);
  }
  async putOnce(reservationId: string, stage: RecoveryCheckpointStage, record: RecoveryCheckpoint) {
    const id = key(reservationId, stage);
    const value = existingOrNew(this.records.get(id) ?? null, record);
    this.records.set(id, value);
    return structuredClone(value);
  }
}

export class FirestoreRecoveryCheckpointStore implements RecoveryCheckpointStore {
  constructor(private readonly firestore: Firestore, private readonly collectionPrefix: string) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/u.test(collectionPrefix)) throw new TypeError("Invalid checkpoint collection prefix");
  }
  private ref(reservationId: string, stage: RecoveryCheckpointStage) {
    return this.firestore.collection(`${this.collectionPrefix}_recovery_checkpoints`).doc(key(reservationId, stage));
  }
  private decode(raw: Record<string, unknown> | undefined): RecoveryCheckpoint | null {
    if (!raw) return null;
    const record = raw.record as RecoveryCheckpoint;
    if (!record || canonicalHash(record) !== raw.recordHash) throw new Error("Recovery checkpoint integrity failure");
    return validated(record);
  }
  async get(reservationId: string, stage: RecoveryCheckpointStage) {
    return this.decode((await this.ref(reservationId, stage).get()).data());
  }
  async putOnce(reservationId: string, stage: RecoveryCheckpointStage, record: RecoveryCheckpoint) {
    const input = validated(record);
    const ref = this.ref(reservationId, stage);
    return this.firestore.runTransaction(async (transaction) => {
      const existing = this.decode((await transaction.get(ref)).data());
      const value = existingOrNew(existing, input);
      if (!existing) transaction.create(ref, { record: value, recordHash: canonicalHash(value) });
      return value;
    });
  }
}
