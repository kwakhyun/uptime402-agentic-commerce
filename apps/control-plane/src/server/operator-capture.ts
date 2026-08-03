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
  OperatorIncidentCaptureInput,
  OperatorIncidentCaptureStore,
} from "./operator-boundary.js";

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
}
