import { IdentifierSchema } from "@uptime402/domain";
import { resumePaidIncident } from "../apps/control-plane/src/server/live-flow-finalization.js";
import { buildProductionControlPlaneLiveFlow } from "../apps/control-plane/src/server/runtime.js";

// Run with the private capture control-plane identity and outcome key configuration.
// Checkpoint data is read from Firestore; no payment payload is sent or re-signed.
async function main() {
  if (process.argv.length !== 3) throw new Error("Usage: pnpm incident:resume RESERVATION_ID");
  const reservationId = IdentifierSchema.parse(process.argv[2]);
  const flow = await buildProductionControlPlaneLiveFlow();
  const result = await resumePaidIncident(reservationId, flow.dependencies);
  process.stdout.write(JSON.stringify({
    reservationId, outcome: result.outcome,
    reasonCode: result.outcome === "reconciliation_required" ? result.reasonCode : null,
    paymentRetried: false, settlementRetried: false,
  }) + "\n");
  if (result.outcome !== "recovered") process.exitCode = 2;
}

main().catch(() => {
  // Provider/config exceptions can contain private endpoint details.
  process.stderr.write("Paid continuation failed; inspect the private checkpoint and configuration. No payment was retried.\n");
  process.exitCode = 1;
});
