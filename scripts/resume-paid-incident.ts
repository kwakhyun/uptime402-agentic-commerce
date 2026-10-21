import { Firestore } from "@google-cloud/firestore";
import { FirestoreOperatorIncidentCaptureStore } from "../apps/control-plane/src/server/operator-capture.js";
import { IdentifierSchema } from "@uptime402/domain";
import { resumePaidIncident } from "../apps/control-plane/src/server/live-flow-finalization.js";
import { buildProductionControlPlaneLiveFlow } from "../apps/control-plane/src/server/runtime.js";

// Run with the private capture control-plane identity and outcome key configuration.
// Checkpoint data is read from Firestore; no payment payload is sent or re-signed.
async function main() {
  if (process.argv.length !== 3) throw new Error("Usage: pnpm incident:resume RESERVATION_ID");
  const reservationId = IdentifierSchema.parse(process.argv[2]);
  const flow = await buildProductionControlPlaneLiveFlow();
  const runSlot = IdentifierSchema.parse(process.env.CONTROL_PLANE_DEMO_RUN_SLOT);
  const firestore = new Firestore({ projectId: flow.config.firestoreProjectId, databaseId: flow.config.firestoreDatabaseId });
  const captures = new FirestoreOperatorIncidentCaptureStore(firestore, `${flow.config.firestoreCollectionPrefix}_operator_captures`);
  const captured = await captures.read(runSlot);
  const primary = captured.original.result.primary;
  if (primary.outcome !== "reconciliation_required" || primary.reservationId !== reservationId) throw new Error("Run slot does not match the paid continuation");
  const result = await resumePaidIncident(reservationId, flow.dependencies);
  if (result.outcome === "recovered") await captures.appendRecovery(runSlot, result, new Date().toISOString());
  await firestore.terminate();
  process.stdout.write(JSON.stringify({
    reservationId, outcome: result.outcome,
    reasonCode: result.outcome === "reconciliation_required" ? result.reasonCode : null,
    paymentRetried: false, settlementRetried: false,
    operatorCaptureUpdated: result.outcome === "recovered",
  }) + "\n");
  if (result.outcome !== "recovered") process.exitCode = 2;
}

main().catch(() => {
  // Provider/config exceptions can contain private endpoint details.
  process.stderr.write("Paid continuation failed; inspect the private checkpoint and configuration. No payment was retried.\n");
  process.exitCode = 1;
});
