import "server-only";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { ReissuedFulfillmentSchema, RecoveryOutcomePayloadSchema, sha256Bytes, parseStrictJson } from "@uptime402/domain";
import { z } from "zod";
import { FREE_RECOVERY_EVIDENCE_HASH, FREE_RECOVERY_REPORT_HASH } from "./free-recovery-pins.js";

const PublicRecoverySchema = z.object({
  capturedAt: z.string().datetime(), reissue: ReissuedFulfillmentSchema,
  recovery: z.object({ recoveryOutcome: z.object({ payload: RecoveryOutcomePayloadSchema }),
    healthProbe: z.object({ details: z.object({ latencyMs: z.number(), genesisHash: z.string() }) }) }),
  walletAfter: z.object({ payerUsdcBaseUnits: z.string() }),
  reservationAfter: z.object({ state: z.literal("committed"), amountBaseUnits: z.literal("15000") }),
  originalRecordsPreserved: z.literal(true), completion: z.object({ newPaymentCount: z.literal(0) }),
});

export async function loadFreeRecoveryEvidence(options: { artifactRoot?: string } = {}) {
  const root = resolve(options.artifactRoot ?? (process.env.UPTIME402_ARTIFACT_ROOT?.trim() || resolve(process.cwd(), "artifacts")));
  // Final deployments point ARTIFACT_ROOT at the active replay bundle. The
  // append-only follow-up is its sibling, not a nested replay directory.
  const directory = basename(dirname(root)) === "runs"
    ? resolve(root, "../first-payment-reissue-2026-10-22")
    : resolve(root, "runs/first-payment-reissue-2026-10-22");
  const [evidenceBytes, reportBytes] = await Promise.all([readFile(resolve(directory, "evidence.json")), readFile(resolve(directory, "verification-report.json"))]);
  if (sha256Bytes(evidenceBytes) !== FREE_RECOVERY_EVIDENCE_HASH || sha256Bytes(reportBytes) !== FREE_RECOVERY_REPORT_HASH) throw new Error("Free recovery evidence hash mismatch");
  const raw = parseStrictJson(evidenceBytes.toString("utf8"));
  const report = z.object({ evidenceSha256: z.literal(FREE_RECOVERY_EVIDENCE_HASH),
    checks: z.record(z.string(), z.boolean()), liveSettlementReverified: z.literal(true) }).parse(parseStrictJson(reportBytes.toString("utf8")));
  if (!Object.values(report.checks).every(Boolean) || Object.keys(report.checks).length !== 10) throw new Error("Free recovery verification incomplete");
  return { data: PublicRecoverySchema.parse(raw), raw, report };
}
