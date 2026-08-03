import "server-only";

import type { DocumentReference, Firestore } from "@google-cloud/firestore";
import {
  Base58Schema,
  IdentifierSchema,
  Sha256Schema,
  TimestampSchema,
  canonicalHash,
  canonicalize,
  type JsonValue,
} from "@uptime402/domain";
import { z } from "zod";

import { MandateAdministrationResponseSchema } from "./operator-executor-proxy.js";

export const OperatorActionKindSchema = z.enum([
  "mandate.arm",
  "mandate.revoke",
  "incident.run",
]);
export type OperatorActionKind = z.infer<typeof OperatorActionKindSchema>;

const CommonActionShape = {
  actionId: IdentifierSchema,
  kind: OperatorActionKindSchema,
  subjectId: IdentifierSchema,
  requestHash: Sha256Schema,
  principalHash: Sha256Schema,
  claimedAt: TimestampSchema,
} as const;

const MandateSummarySchema = z
  .object({
    type: z.literal("mandate_administration"),
    response: MandateAdministrationResponseSchema,
  })
  .strict();

const IncidentSummarySchema = z
  .object({
    type: z.literal("incident_result"),
    primary: z
      .object({
        outcome: z.enum(["recovered", "denied", "reconciliation_required"]),
        transactionCreated: z.boolean(),
        txSignature: z.union([Base58Schema, z.null()]),
        resultHash: Sha256Schema,
      })
      .strict(),
    denials: z
      .object({
        overTransactionLimit: z
          .object({
            outcome: z.literal("denied"),
            reasonCode: z.literal("amount.per_transaction_limit"),
            transactionCreated: z.literal(false),
            txSignature: z.null(),
            resultHash: Sha256Schema,
            bindingHash: Sha256Schema,
          })
          .strict(),
        replay: z
          .object({
            outcome: z.literal("denied"),
            reasonCode: z.literal("identifier.nonce_fresh"),
            transactionCreated: z.literal(false),
            txSignature: z.null(),
            resultHash: Sha256Schema,
            bindingHash: Sha256Schema,
          })
          .strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const FailureSummarySchema = z
  .object({
    type: z.literal("failed_locked"),
    errorCode: z.string().min(1).max(128),
  })
  .strict();

export const OperatorActionSummarySchema = z.discriminatedUnion("type", [
  MandateSummarySchema,
  IncidentSummarySchema,
  FailureSummarySchema,
]);
export type OperatorActionSummary = z.infer<typeof OperatorActionSummarySchema>;

const RunningActionRecordSchema = z
  .object({
    ...CommonActionShape,
    state: z.literal("running"),
  })
  .strict();

const TerminalActionRecordSchema = z
  .object({
    ...CommonActionShape,
    state: z.enum(["completed", "failed_locked"]),
    terminalAt: TimestampSchema,
    resultHash: Sha256Schema,
    summary: OperatorActionSummarySchema,
  })
  .strict();

export const OperatorActionRecordSchema = z.discriminatedUnion("state", [
  RunningActionRecordSchema,
  TerminalActionRecordSchema,
]);
export type OperatorActionRecord = z.infer<typeof OperatorActionRecordSchema>;

const StoredActionEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("1"),
    recordHash: Sha256Schema,
    value: OperatorActionRecordSchema,
  })
  .strict();

export type OperatorActionClaimInput = Readonly<{
  kind: OperatorActionKind;
  subjectId: string;
  requestHash: `sha256:${string}`;
  principalHash: `sha256:${string}`;
  claimedAt: string;
}>;

export type OperatorActionClaimResult =
  | Readonly<{ kind: "claimed"; record: OperatorActionRecord }>
  | Readonly<{ kind: "existing"; record: OperatorActionRecord }>
  | Readonly<{ kind: "conflict"; record: OperatorActionRecord }>;

export interface OperatorActionGuard {
  claim(input: OperatorActionClaimInput): Promise<OperatorActionClaimResult>;
  complete(
    input: OperatorActionClaimInput,
    terminalAt: string,
    summary: Exclude<OperatorActionSummary, { type: "failed_locked" }>,
  ): Promise<OperatorActionRecord>;
  failLocked(
    input: OperatorActionClaimInput,
    terminalAt: string,
    errorCode: string,
  ): Promise<OperatorActionRecord>;
}

function actionId(kind: OperatorActionKind, subjectId: string): string {
  const digest = canonicalHash({ kind, subjectId }).slice("sha256:".length);
  return `operator-${digest.slice(0, 48)}`;
}

function createRunningRecord(input: OperatorActionClaimInput): OperatorActionRecord {
  return RunningActionRecordSchema.parse({
    actionId: actionId(input.kind, input.subjectId),
    kind: input.kind,
    subjectId: input.subjectId,
    requestHash: input.requestHash,
    principalHash: input.principalHash,
    claimedAt: input.claimedAt,
    state: "running",
  });
}

function hasSameClaim(
  record: OperatorActionRecord,
  input: OperatorActionClaimInput,
): boolean {
  return (
    record.actionId === actionId(input.kind, input.subjectId) &&
    record.kind === input.kind &&
    record.subjectId === input.subjectId &&
    record.requestHash === input.requestHash &&
    record.principalHash === input.principalHash
  );
}

function createTerminalRecord(
  input: OperatorActionClaimInput,
  terminalAt: string,
  state: "completed" | "failed_locked",
  summary: OperatorActionSummary,
): z.infer<typeof TerminalActionRecordSchema> {
  const validatedSummary = OperatorActionSummarySchema.parse(summary);
  return TerminalActionRecordSchema.parse({
    ...createRunningRecord(input),
    state,
    terminalAt,
    resultHash: canonicalHash(validatedSummary),
    summary: validatedSummary,
  });
}

function asEnvelope(record: OperatorActionRecord) {
  return {
    schemaVersion: "1" as const,
    recordHash: canonicalHash(record),
    value: record,
  };
}

function parseStoredRecord(value: unknown): OperatorActionRecord {
  const envelope = StoredActionEnvelopeSchema.parse(value);
  if (canonicalHash(envelope.value) !== envelope.recordHash) {
    throw new Error("Operator action guard integrity check failed");
  }
  return envelope.value;
}

/**
 * Firestore-backed fail-closed one-shot guard. A running or failed action is
 * never lease-released automatically because payment submission may be
 * ambiguous; a new server-configured demo slot is required after reconciliation.
 */
export class FirestoreOperatorActionGuard implements OperatorActionGuard {
  constructor(
    readonly firestore: Firestore,
    readonly collectionName: string,
  ) {
    if (!/^[a-z][a-z0-9_-]{0,79}$/u.test(collectionName)) {
      throw new TypeError("Operator action collection name is invalid");
    }
  }

  private reference(input: Pick<OperatorActionClaimInput, "kind" | "subjectId">): DocumentReference {
    return this.firestore.collection(this.collectionName).doc(actionId(input.kind, input.subjectId));
  }

  async claim(input: OperatorActionClaimInput): Promise<OperatorActionClaimResult> {
    const candidate = createRunningRecord(input);
    const reference = this.reference(input);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        transaction.create(reference, asEnvelope(candidate));
        return { kind: "claimed" as const, record: candidate };
      }
      const existing = parseStoredRecord(snapshot.data());
      return hasSameClaim(existing, input)
        ? { kind: "existing" as const, record: existing }
        : { kind: "conflict" as const, record: existing };
    });
  }

  async complete(
    input: OperatorActionClaimInput,
    terminalAt: string,
    summary: Exclude<OperatorActionSummary, { type: "failed_locked" }>,
  ): Promise<OperatorActionRecord> {
    return this.writeTerminal(input, terminalAt, "completed", summary);
  }

  async failLocked(
    input: OperatorActionClaimInput,
    terminalAt: string,
    errorCode: string,
  ): Promise<OperatorActionRecord> {
    return this.writeTerminal(input, terminalAt, "failed_locked", {
      type: "failed_locked",
      errorCode,
    });
  }

  private async writeTerminal(
    input: OperatorActionClaimInput,
    terminalAt: string,
    state: "completed" | "failed_locked",
    summary: OperatorActionSummary,
  ): Promise<OperatorActionRecord> {
    const terminal = createTerminalRecord(input, terminalAt, state, summary);
    const reference = this.reference(input);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new Error("Operator action was not claimed");
      const existing = parseStoredRecord(snapshot.data());
      if (!hasSameClaim(existing, input)) throw new Error("Operator action claim conflict");
      if (existing.state !== "running" && "resultHash" in existing) {
        if (existing.resultHash !== terminal.resultHash || existing.state !== terminal.state) {
          throw new Error("Operator action terminal state conflict");
        }
        return existing;
      }
      transaction.set(reference, asEnvelope(terminal));
      return terminal;
    });
  }
}

/** Deterministic test adapter with the same no-release semantics as Firestore. */
export class InMemoryOperatorActionGuard implements OperatorActionGuard {
  private readonly records = new Map<string, OperatorActionRecord>();

  async claim(input: OperatorActionClaimInput): Promise<OperatorActionClaimResult> {
    const candidate = createRunningRecord(input);
    const existing = this.records.get(candidate.actionId);
    if (!existing) {
      this.records.set(candidate.actionId, structuredClone(candidate));
      return { kind: "claimed", record: structuredClone(candidate) };
    }
    return hasSameClaim(existing, input)
      ? { kind: "existing", record: structuredClone(existing) }
      : { kind: "conflict", record: structuredClone(existing) };
  }

  async complete(
    input: OperatorActionClaimInput,
    terminalAt: string,
    summary: Exclude<OperatorActionSummary, { type: "failed_locked" }>,
  ): Promise<OperatorActionRecord> {
    return this.writeTerminal(input, terminalAt, "completed", summary);
  }

  async failLocked(
    input: OperatorActionClaimInput,
    terminalAt: string,
    errorCode: string,
  ): Promise<OperatorActionRecord> {
    return this.writeTerminal(input, terminalAt, "failed_locked", {
      type: "failed_locked",
      errorCode,
    });
  }

  private writeTerminal(
    input: OperatorActionClaimInput,
    terminalAt: string,
    state: "completed" | "failed_locked",
    summary: OperatorActionSummary,
  ): OperatorActionRecord {
    const id = actionId(input.kind, input.subjectId);
    const existing = this.records.get(id);
    if (!existing || !hasSameClaim(existing, input)) {
      throw new Error("Operator action claim conflict");
    }
    const terminal = createTerminalRecord(input, terminalAt, state, summary);
    if (existing.state !== "running" && "resultHash" in existing) {
      if (existing.state !== state || existing.resultHash !== terminal.resultHash) {
        throw new Error("Operator action terminal state conflict");
      }
      return structuredClone(existing);
    }
    this.records.set(id, structuredClone(terminal));
    return structuredClone(terminal);
  }
}

export function hashOperatorPrincipal(principal: string): `sha256:${string}` {
  return canonicalHash({ googleOidcPrincipal: principal });
}

export function asOperatorAuditJson(value: unknown): JsonValue {
  return JSON.parse(canonicalize(value)) as JsonValue;
}
