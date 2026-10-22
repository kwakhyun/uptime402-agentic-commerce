import type { Firestore } from "@google-cloud/firestore";
import { canonicalHash, IdentifierSchema, ReissueApprovalSchema, ReissuedFulfillmentSchema, type ReissuedFulfillment } from "@uptime402/domain";
import type { z } from "zod";

export interface RecoveryReissueStore {
  readApproval(approvalId: string): Promise<z.infer<typeof ReissueApprovalSchema> | null>;
  readForPayment(paymentId: string): Promise<ReissuedFulfillment | null>;
  createOnce(value: ReissuedFulfillment): Promise<ReissuedFulfillment>;
}

function unwrap(raw: Record<string, unknown> | undefined): unknown | null {
  if (!raw) return null;
  if (raw.schemaVersion !== "1" || canonicalHash(raw.value) !== raw.recordHash) throw new Error("Reissue record integrity failure");
  return raw.value;
}
const wrap = (value: unknown) => ({ schemaVersion: "1", recordHash: canonicalHash(value), value });

export class FirestoreRecoveryReissueStore implements RecoveryReissueStore {
  constructor(private readonly firestore: Firestore, private readonly prefix: string) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/u.test(prefix)) throw new Error("Invalid reissue collection prefix");
  }
  private ref(kind: string, id: string) {
    IdentifierSchema.parse(id);
    return this.firestore.collection(`${this.prefix}_${kind}`).doc(id);
  }
  async readApproval(id: string) {
    const raw = unwrap((await this.ref("reissue_approvals", id).get()).data());
    return raw ? ReissueApprovalSchema.parse(raw) : null;
  }
  async readForPayment(id: string) {
    const raw = unwrap((await this.ref("reissues", id).get()).data());
    return raw ? ReissuedFulfillmentSchema.parse(raw) : null;
  }
  async createOnce(input: ReissuedFulfillment) {
    const value = ReissuedFulfillmentSchema.parse(input);
    const ref = this.ref("reissues", value.approval.paymentId);
    const activation = this.ref("recovery_resources", value.resource.activationId);
    return this.firestore.runTransaction(async tx => {
      const [approval, original, existing] = await tx.getAll(
        this.ref("reissue_approvals", value.approval.approvalId),
        this.ref("recovery_resources", value.approval.originalActivationId), ref);
      if (canonicalHash(unwrap(approval!.data())) !== canonicalHash(value.approval) ||
          canonicalHash(unwrap(original!.data())) !== canonicalHash(value.originalResource)) throw new Error("Reissue approval/history changed");
      if (existing!.exists) {
        const saved = ReissuedFulfillmentSchema.parse(unwrap(existing!.data()));
        if (canonicalHash(saved.approval) !== canonicalHash(value.approval)) throw new Error("Payment already reissued under another approval");
        return saved; // Concurrent retries return the first lease; never extend it.
      }
      tx.create(ref, wrap(value));
      tx.create(activation, wrap(value.resource));
      return value;
    });
  }
}
