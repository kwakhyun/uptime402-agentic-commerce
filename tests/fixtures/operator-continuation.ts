import { canonicalHash } from "@uptime402/domain";
import type { FreshOperatorIncidentMutationResult } from "../../apps/control-plane/src/server/operator-boundary.js";
import type { RecoveredIncidentResult } from "../../apps/control-plane/src/server/live-flow-contracts.js";

/** Storage/projection fixture only; never a payment or cryptographic proof. */
export function operatorContinuationFixture() {
  const common = {
    correlationId: "corr-storage-test", reservationId: "reservation-storage-test",
    incident: { id: "incident-storage-test" },
    selectedOffer: { payload: { offerId: "offer-storage-test", amountBaseUnits: "10000" } },
    transactionCreated: true,
  };
  const pending = { ...common, outcome: "reconciliation_required", txSignature: null };
  const response = {
    schemaVersion: "1", separation: "application-role", idempotentReplay: false,
    result: { primary: pending, denials: null, denialBindings: null, denialBindingHashes: null },
  } as unknown as FreshOperatorIncidentMutationResult;
  const requestFingerprint = canonicalHash("storage-request");
  const recovered = {
    ...common, outcome: "recovered", txSignature: "T".repeat(88), requestFingerprint,
    resource: { paymentId: "payment-storage-test", txSignature: "T".repeat(88) },
    policyEvidence: { reservation: {
      reservationId: common.reservationId, state: "committed", requestFingerprint,
      paymentId: "payment-storage-test",
    } },
  } as unknown as RecoveredIncidentResult;
  const input = { runSlot: "slot-storage-test", requestHash: canonicalHash("operator-request"),
    capturedAt: "2026-10-22T00:00:00.000Z", response };
  return { input, recovered };
}
