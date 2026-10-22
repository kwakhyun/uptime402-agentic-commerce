import { canonicalHash } from "@uptime402/domain";
import { verifyReissuedFulfillment } from "@uptime402/payments";
import { describe, it, expect } from "vitest";
import { reissuePaidRecovery } from "../services/vendor-agent/src/reissue.js";
import { executePaidRpc } from "../services/vendor-agent/src/paid-rpc.js";
import { reissueFixture } from "./fixtures/reissue.js";

describe("one-time free paid-access reissue", () => {
  it("preserves the expired resource and receipt, and grants real-adapter access without settlement", async () => {
    const f = reissueFixture(), original = canonicalHash({ resource: f.original, claim: f.claim });
    const result = await reissuePaidRecovery(f.deps, f.approval.approvalId);
    expect(canonicalHash({ resource: f.original, claim: f.claim })).toBe(original);
    expect(result.resource.reissue?.additionalAmountBaseUnits).toBe("0");
    expect(await executePaidRpc(f.deps, f.original.activationId, { jsonrpc: "2.0", id: 0, method: "getHealth" })).toMatchObject({ status: 410 });
    expect(await executePaidRpc(f.deps, result.resource.activationId, { jsonrpc: "2.0", id: 0, method: "getHealth" })).toMatchObject({ status: 200 });
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.verifySettlement).toHaveBeenCalledOnce();
    expect(f.settle).not.toHaveBeenCalled();
    f.deps.now = () => result.resource.expiresAt;
    expect(await executePaidRpc(f.deps, result.resource.activationId, { jsonrpc: "2.0", id: 0, method: "getHealth" })).toMatchObject({ status: 410 });
  });
  it("retries and concurrent callers keep the first lease even after it expires", async () => {
    const f = reissueFixture();
    const values = await Promise.all([reissuePaidRecovery(f.deps, f.approval.approvalId), reissuePaidRecovery(f.deps, f.approval.approvalId)]);
    expect(values[0]).toEqual(values[1]);
    f.deps.now = () => "2026-10-23T00:00:00.000Z";
    expect(await reissuePaidRecovery(f.deps, f.approval.approvalId)).toEqual(values[0]);
    f.approval.approvalId = "second-approval";
    await expect(reissuePaidRecovery(f.deps, "second-approval")).rejects.toThrow("already reissued");
  });
  it.each(["unpaid", "transaction", "approval", "not-expired", "grant-expired", "chain"])("rejects %s without a new lease or payment", async kind => {
    const f = reissueFixture();
    if (kind === "unpaid") f.claim.state = "settling";
    if (kind === "transaction") f.claim.txSignature = "2".repeat(88);
    if (kind === "approval") f.approval.originalReceiptHash = `sha256:${"0".repeat(64)}`;
    if (kind === "not-expired") f.deps.now = () => f.original.activatedAt;
    if (kind === "grant-expired") f.deps.now = () => f.approval.expiresAt;
    if (kind === "chain") f.verifySettlement.mockRejectedValue(new Error("not finalized"));
    await expect(reissuePaidRecovery(f.deps, f.approval.approvalId)).rejects.toThrow();
    expect(f.saved).toBeNull(); expect(f.settle).not.toHaveBeenCalled();
  });
  it.each(["ttl", "history", "payment", "signature"])("rejects tampered %s from storage or the wire", async kind => {
    const f = reissueFixture();
    const value = structuredClone(await reissuePaidRecovery(f.deps, f.approval.approvalId));
    if (kind === "ttl") value.resource.expiresAt = f.approval.expiresAt;
    if (kind === "history") value.originalResource.expiresAt = value.resource.expiresAt;
    if (kind === "payment") value.fulfillmentReceipt.payload.amountBaseUnits = "1";
    if (kind === "signature") value.fulfillmentReceipt.signature = "2".repeat(88);
    await expect(verifyReissuedFulfillment(value, { publicKey: f.receipt.signer, keyId: f.receipt.keyId })).rejects.toThrow();
  });
});
