import { readFile } from "node:fs/promises";
import { canonicalHash, RecoveryOutcomePayloadSchema, sha256Bytes, verifyRpcRecoveryProof } from "@uptime402/domain";
import { verifyCanonicalEd25519Signature, verifyReissuedFulfillment, verifySolanaSettlement } from "@uptime402/payments";

// Append-only follow-up verifier. It never rewrites the original evidence/report.
const path = process.argv[2];
if (!path || !path.startsWith("artifacts/runs/")) throw new Error("Usage: verify-free-recovery.ts artifacts/runs/.../evidence.json [--live]");
const bytes = await readFile(path);
const evidence = JSON.parse(bytes.toString("utf8"));
const originalBytes = await readFile("artifacts/runs/rpc-recovery-2026-10-22/attempts/first-paid-recovery-incomplete.json");
const original = JSON.parse(originalBytes.toString("utf8"));
const prior = JSON.parse(await readFile("artifacts/runs/rpc-recovery-2026-10-22/payment-evidence.json", "utf8"));
const vendor = prior.payments[0].fulfillmentReceipt;
const control = prior.payments[0].outcome;
const grant = await verifyReissuedFulfillment(evidence.reissue, { publicKey: vendor.signer, keyId: vendor.keyId });
const outcome = evidence.recovery.recoveryOutcome;
const payload = RecoveryOutcomePayloadSchema.parse(outcome.payload);
if (outcome.signer !== control.signer || outcome.keyId !== control.keyId || outcome.signer === vendor.signer ||
    !(await verifyCanonicalEd25519Signature({ payload, payloadSchema: RecoveryOutcomePayloadSchema, signerPublicKey: control.signer, signature: outcome.signature }))) throw new Error("Recovery outcome signature mismatch");
if (canonicalHash(grant.originalReceipt) !== canonicalHash(original.fulfillmentReceipt) ||
    canonicalHash(grant.originalResource) !== canonicalHash(original.resource) ||
    evidence.originalEvidenceSha256 !== sha256Bytes(originalBytes) ||
    payload.fulfillmentReceiptHash !== canonicalHash(grant.fulfillmentReceipt) || payload.resourceResponseHash !== canonicalHash(grant.resource) ||
    payload.incidentId !== grant.resource.incidentId || payload.paymentId !== grant.resource.paymentId || payload.statusAfter !== "healthy") throw new Error("Original payment/recovery binding mismatch");
verifyRpcRecoveryProof({ resource: grant.resource, healthProbe: evidence.recovery.healthProbe }, {
  ...grant.resource, resourceResponseHash: payload.resourceResponseHash, healthProbeHash: payload.healthProbeHash,
  fulfilledAt: grant.fulfillmentReceipt.payload.fulfilledAt, recoveredAt: payload.recoveredAt,
});
if (evidence.reservationAfter.state !== "committed" || evidence.reservationAfter.txSignature !== grant.resource.txSignature ||
    evidence.reservationBefore.reservationId !== evidence.reservationAfter.reservationId ||
    evidence.reservationAfter.amountBaseUnits !== "15000" || evidence.reservationAfter.paymentId !== grant.resource.paymentId ||
    canonicalHash(evidence.budgetBefore) !== canonicalHash(evidence.budgetAfter) ||
    evidence.walletBefore.payerUsdcBaseUnits !== evidence.walletAfter.payerUsdcBaseUnits ||
    evidence.walletBefore.payeeUsdcBaseUnits !== evidence.walletAfter.payeeUsdcBaseUnits ||
    evidence.walletBefore.payerSolLamports !== evidence.walletAfter.payerSolLamports ||
    canonicalHash(evidence.transfersBefore) !== canonicalHash(evidence.transfersAfter) ||
    evidence.completion.newPaymentCount !== 0 || evidence.completion.originalAccessStatus !== 410 ||
    evidence.completion.executorIamStatus !== 403 || evidence.originalRecordsPreserved !== true) throw new Error("Budget/payment preservation verification failed");
let chainVerified = false;
if (process.argv.includes("--live")) {
  const receipt = grant.originalReceipt.payload;
  await verifySolanaSettlement({ rpc: { rpcUrl: "https://api.devnet.solana.com" }, txSignature: receipt.txSignature,
    payerOwner: receipt.payer, payeeOwner: receipt.payee, assetMint: receipt.assetMint, amountBaseUnits: receipt.amountBaseUnits });
  chainVerified = true;
}
process.stdout.write(JSON.stringify({ schemaVersion: "1", producedAt: new Date().toISOString(), evidenceSha256: sha256Bytes(bytes),
  checks: { originalEvidencePreserved: true, vendorReceiptChain: true, outcomeSignature: true, actualRpcResponseBinding: true,
    expiredAccessDenied: true, workerExecutorDenied: true, budgetUnchanged: true, walletUnchanged: true,
    noAdditionalTransfer: true, existingReservationCommitted: true }, liveSettlementReverified: chainVerified }, null, 2) + "\n");
