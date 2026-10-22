import { loadFreeRecoveryEvidence } from "../../../../src/server/free-recovery-evidence";

export const dynamic = "force-dynamic";
export async function GET() {
  const evidence = await loadFreeRecoveryEvidence();
  return Response.json({ evidence: evidence.raw, verification: evidence.report }, { headers: { "cache-control": "no-store" } });
}
