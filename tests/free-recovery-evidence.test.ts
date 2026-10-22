import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFreeRecoveryEvidence } from "../apps/control-plane/src/server/free-recovery-evidence.js";

describe("public free recovery evidence deployment roots", () => {
  it.each(["artifacts", "artifacts/runs/rpc-recovery-2026-10-22"])("loads the hash-pinned follow-up from %s", async root => {
    const value = await loadFreeRecoveryEvidence({ artifactRoot: resolve(root) });
    expect(value.data.reservationAfter.state).toBe("committed");
    expect(value.data.completion.newPaymentCount).toBe(0);
    expect(value.data.reissue.resource.reissue?.originalReceiptHash).toBe(value.data.reissue.approval.originalReceiptHash);
    expect(value.report.liveSettlementReverified).toBe(true);
  });
});
