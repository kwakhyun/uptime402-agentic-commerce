import "server-only";

import type { Firestore } from "@google-cloud/firestore";
import {
  IdentifierSchema,
  Sha256Schema,
  TimestampSchema,
  canonicalHash,
  canonicalize,
} from "@uptime402/domain";

import type {
  FreshOperatorIncidentMutationResult,
  OperatorIncidentCaptureInput,
  OperatorIncidentCaptureStore,
} from "./operator-boundary.js";
import type { RecoveredIncidentResult } from "./live-flow-contracts.js";
import { FreshRunResponseSchema } from "./operator-capture-schema.js";
import { z } from "zod";

const CaptureSchema = z.object({
  schemaVersion: z.literal("1"), runSlot: IdentifierSchema, requestHash: Sha256Schema,
  capturedAt: TimestampSchema, responseHash: Sha256Schema, value: FreshRunResponseSchema,
}).strict();
const ContinuationSchema = CaptureSchema.extend({
  parentResponseHash: Sha256Schema, originalPrimaryHash: Sha256Schema,
}).strict();

export function validateStoredOperatorCapture(input: {
  raw: unknown; expectedRunSlot: string; expectedRequestHash?: string;
}): FreshOperatorIncidentMutationResult {
  const envelope = CaptureSchema.parse(input.raw);
  if (envelope.runSlot !== input.expectedRunSlot ||
      (input.expectedRequestHash !== undefined && envelope.requestHash !== input.expectedRequestHash) ||
      envelope.responseHash !== canonicalHash(envelope.value)) throw new Error("Stored operator capture failed its run/request/response binding");
  return envelope.value as unknown as FreshOperatorIncidentMutationResult;
}

function continuedResponse(original: FreshOperatorIncidentMutationResult, result: RecoveredIncidentResult): FreshOperatorIncidentMutationResult {
  const previous = original.result.primary;
  if (previous.outcome !== "reconciliation_required" || result.outcome !== "recovered" ||
      previous.reservationId !== result.reservationId || previous.correlationId !== result.correlationId ||
      canonicalHash(previous.incident) !== canonicalHash(result.incident) ||
      canonicalHash(previous.selectedOffer) !== canonicalHash(result.selectedOffer) ||
      (previous.txSignature !== null && previous.txSignature !== result.txSignature) ||
      result.policyEvidence.reservation.state !== "committed" ||
      result.policyEvidence.reservation.reservationId !== result.reservationId ||
      result.policyEvidence.reservation.requestFingerprint !== result.requestFingerprint ||
      result.policyEvidence.reservation.paymentId !== result.resource.paymentId ||
      result.resource.txSignature !== result.txSignature) throw new Error("Operator continuation payment binding mismatch");
  // Denial evidence is never invented or rerun by a paid continuation.
  return { ...original, result: { ...original.result, primary: result } };
}

export function projectOperatorContinuation(raw: unknown, continuation: unknown): FreshOperatorIncidentMutationResult {
  const original = CaptureSchema.parse(raw);
  const response = validateStoredOperatorCapture({ raw, expectedRunSlot: original.runSlot });
  const next = ContinuationSchema.parse(continuation);
  if (next.runSlot !== original.runSlot || next.requestHash !== original.requestHash ||
      next.parentResponseHash !== original.responseHash || next.originalPrimaryHash !== canonicalHash(response.result.primary) ||
      next.responseHash !== canonicalHash(next.value) || Date.parse(next.capturedAt) < Date.parse(original.capturedAt)) throw new Error("Operator continuation history binding mismatch");
  const projected = continuedResponse(response, next.value.result.primary as unknown as RecoveredIncidentResult);
  if (canonicalHash(projected) !== next.responseHash) throw new Error("Operator continuation changed unrelated evidence");
  return projected;
}

function captureDocumentId(runSlot: string): string {
  const digest = canonicalHash({ kind: "incident.capture", runSlot }).slice(
    "sha256:".length,
  );
  return `capture-${digest.slice(0, 48)}`;
}

/**
 * Private, server-side retention for the one fresh operator response. The UI
 * continues to receive only its reduced projection; the full signed x402 and
 * denial transcript remains recoverable through project IAM for promotion.
 */
export class FirestoreOperatorIncidentCaptureStore
  implements OperatorIncidentCaptureStore
{
  constructor(
    readonly firestore: Firestore,
    readonly collectionName: string,
  ) {
    if (!/^[a-z][a-z0-9_-]{0,79}$/u.test(collectionName)) {
      throw new TypeError("Operator capture collection name is invalid");
    }
  }

  async create(input: OperatorIncidentCaptureInput): Promise<void> {
    const runSlot = IdentifierSchema.parse(input.runSlot);
    const requestHash = Sha256Schema.parse(input.requestHash);
    const capturedAt = TimestampSchema.parse(input.capturedAt);
    canonicalize(input.response);
    const envelope = {
      schemaVersion: "1" as const,
      runSlot,
      requestHash,
      capturedAt,
      responseHash: canonicalHash(input.response),
      value: input.response,
    };
    await this.firestore
      .collection(this.collectionName)
      .doc(captureDocumentId(runSlot))
      .create(envelope);
  }

  private ref(runSlot: string) {
    return this.firestore.collection(this.collectionName).doc(captureDocumentId(IdentifierSchema.parse(runSlot)));
  }

  async read(runSlot: string, requestHash?: string) {
    const ref = this.ref(runSlot);
    const [original, continuation] = await this.firestore.getAll(ref, ref.collection("continuations").doc("recovered"));
    const raw = CaptureSchema.parse(original!.data());
    const response = validateStoredOperatorCapture({ raw, expectedRunSlot: runSlot, ...(requestHash === undefined ? {} : { expectedRequestHash: requestHash }) });
    return { requestHash: raw.requestHash, original: response,
      latest: continuation!.exists ? projectOperatorContinuation(raw, continuation!.data()) : response,
      continued: continuation!.exists };
  }

  async getContinuation(runSlot: string, requestHash: string, originalPrimaryHash: string) {
    // Older actions may predate capture retention. Preserve their original summary.
    if (!(await this.ref(runSlot).get()).exists) return null;
    const capture = await this.read(runSlot, requestHash);
    if (canonicalHash(capture.original.result.primary) !== originalPrimaryHash) throw new Error("Operator action/capture binding mismatch");
    return capture.continued ? capture.latest : null;
  }

  async appendRecovery(runSlot: string, result: RecoveredIncidentResult, capturedAt: string): Promise<void> {
    TimestampSchema.parse(capturedAt);
    const ref = this.ref(runSlot);
    const completionRef = ref.collection("continuations").doc("recovered");
    await this.firestore.runTransaction(async (transaction) => {
      const [original, existing] = await transaction.getAll(ref, completionRef);
      const raw = CaptureSchema.parse(original!.data());
      const originalResponse = validateStoredOperatorCapture({ raw, expectedRunSlot: runSlot });
      const value = continuedResponse(originalResponse, result);
      if (existing!.exists) {
        const saved = projectOperatorContinuation(raw, existing!.data());
        if (canonicalHash(saved) !== canonicalHash(value)) throw new Error("Operator continuation conflict");
        return;
      }
      const completion = { ...raw, capturedAt, parentResponseHash: raw.responseHash,
        originalPrimaryHash: canonicalHash(originalResponse.result.primary), responseHash: canonicalHash(value), value };
      projectOperatorContinuation(raw, completion);
      transaction.create(completionRef, completion);
    });
  }
}
