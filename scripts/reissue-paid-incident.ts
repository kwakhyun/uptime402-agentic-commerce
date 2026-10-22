import { Firestore } from "@google-cloud/firestore";
import { canonicalHash, IdentifierSchema } from "@uptime402/domain";
import { FirestoreRecoveryReissueStore, FirestoreTransactionalRepository } from "@uptime402/persistence";
import { FirestoreOperatorIncidentCaptureStore } from "../apps/control-plane/src/server/operator-capture.js";
import { resumeReissuedPaidIncident } from "../apps/control-plane/src/server/live-flow-finalization.js";
import { buildProductionControlPlaneLiveFlow } from "../apps/control-plane/src/server/runtime.js";
import { FirestoreAppliedRouteReader, inspectAppliedDependencyRoute } from "../apps/control-plane/src/server/dependency-health.js";
import { buildRecoveryRpcProbe } from "../apps/control-plane/src/server/recovery-rpc-probe.js";
import { createProductionOriginBoundFetchFactory } from "../apps/control-plane/src/server/pinned-fetch.js";

async function main() {
  const reservationId = IdentifierSchema.parse(process.env.REISSUE_RESERVATION_ID);
  const approvalId = IdentifierSchema.parse(process.env.REISSUE_APPROVAL_ID);
  const runSlot = IdentifierSchema.parse(process.env.CONTROL_PLANE_DEMO_RUN_SLOT);
  const firestore = new Firestore({ projectId: process.env.FIRESTORE_PROJECT_ID! });
  const prefix = process.env.FIRESTORE_COLLECTION_PREFIX!;
  const repository = new FirestoreTransactionalRepository(firestore, { collectionPrefix: prefix });
  const reader = new FirestoreAppliedRouteReader(repository);
  const rpc = buildRecoveryRpcProbe();
  const transport = createProductionOriginBoundFetchFactory({ timeoutMs: 30_000, maxRequestBytes: 16_384, maxResponseBytes: 1_048_576 });
  const vendor = process.env.VENDOR_AGENT_ORIGIN!;
  const flow = await buildProductionControlPlaneLiveFlow({
    // Even an accidental call to the payment path fails locally, before network I/O.
    fetchFactory: { mode: transport.mode, forOrigin(origin) {
      if (origin !== vendor) throw new Error("Free recovery permits only the pinned vendor");
      return async (url, init) => {
        if (new URL(url instanceof Request ? url.url : url).pathname !== "/v1/recovery/reissue" || new Headers(init?.headers).has("payment-signature")) throw new Error("Payment transport forbidden");
        return transport.forOrigin(origin)(url, init);
      };
    } },
    healthProbe: { async probe(input) {
      const started = performance.now();
      const result = await inspectAppliedDependencyRoute({ incidentId: input.incident.id, activationId: input.resource.activationId }, reader, undefined, rpc);
      if (!result.healthy) throw new Error("Applied RPC route is not healthy");
      return { healthy: true, observedAt: new Date().toISOString(), routeActivationId: result.body.routeActivationId,
        statusCode: 200, latencyMs: performance.now() - started, details: result.body.details };
    } },
  });
  const captures = new FirestoreOperatorIncidentCaptureStore(firestore, `${prefix}_operator_captures`);
  const capture = await captures.read(runSlot);
  const approval = await new FirestoreRecoveryReissueStore(firestore, prefix).readApproval(approvalId);
  const reservation = await repository.getReservation(reservationId);
  if (!approval || !reservation || approval.paymentId !== reservation.paymentId ||
      capture.original.result.primary.outcome !== "reconciliation_required" || capture.original.result.primary.reservationId !== reservationId) throw new Error("Operator run/approval mismatch");
  const originalHash = canonicalHash(capture.original);
  const budgetBefore = await repository.getBudgetUsage(reservation.mandateId, reservation.incidentId, reservation.createdAt);
  const token = await flow.dependencies.identityTokenProvider.getIdToken(vendor);
  const oldResponse = await transport.forOrigin(vendor)(`${vendor}/v1/recovery-rpc`, { method: "POST", redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-uptime402-route-activation": approval.originalActivationId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "getHealth" }) });
  if (oldResponse.status !== 410) throw new Error("Original expired access must stay denied");
  const executor = process.env.PAYMENT_EXECUTOR_ORIGIN!;
  const executorToken = await flow.dependencies.identityTokenProvider.getIdToken(executor);
  const denied = await fetch(`${executor}/health`, { headers: { authorization: `Bearer ${executorToken}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (denied.status !== 403) throw new Error("Free recovery worker must have no executor invocation permission");
  const result = await resumeReissuedPaidIncident(reservationId, approvalId, flow.dependencies);
  if (result.outcome !== "recovered") throw new Error(`Free recovery incomplete: ${result.reasonCode}`);
  await captures.appendRecovery(runSlot, result, new Date().toISOString());
  const after = await captures.read(runSlot);
  const budgetAfter = await repository.getBudgetUsage(reservation.mandateId, reservation.incidentId, reservation.createdAt);
  if (canonicalHash(after.original) !== originalHash || canonicalHash(budgetAfter) !== canonicalHash(budgetBefore)) throw new Error("Original capture or budget changed");
  const summary = { reservationId, approvalId, completedAt: new Date().toISOString(), outcome: result.outcome,
    originalCaptureHash: originalHash, originalAccessStatus: oldResponse.status, executorIamStatus: denied.status,
    budgetBefore, budgetAfter, newPaymentCount: 0, paymentRetried: false, settlementRetried: false,
    originalCapturePreserved: true, txSignature: result.txSignature, activationId: result.resource.activationId };
  const ref = firestore.collection(`${prefix}_reissue_completions`).doc(approvalId);
  await firestore.runTransaction(async tx => {
    if (!(await tx.get(ref)).exists) tx.create(ref, { schemaVersion: "1", recordHash: canonicalHash(summary), value: summary });
  });
  process.stdout.write(JSON.stringify(summary) + "\n");
  await firestore.terminate();
}
main().then(() => process.exit(0)).catch(error => {
  // No provider response, private context, or credential is printed.
  console.error(JSON.stringify({ event: "free_recovery_failed", category: error instanceof Error && error.message.startsWith("Free recovery incomplete:") ? error.message : "configuration_or_verification_failed" }));
  process.exit(1);
});
