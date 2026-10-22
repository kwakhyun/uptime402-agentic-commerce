import { Firestore } from "@google-cloud/firestore";
import { canonicalHash } from "@uptime402/domain";
import { FirestoreRecoveryCheckpointStore } from "@uptime402/persistence";
import { afterAll, describe, expect, it } from "vitest";
import { FirestoreOperatorIncidentCaptureStore } from "../apps/control-plane/src/server/operator-capture.js";
import { operatorContinuationFixture } from "./fixtures/operator-continuation.js";
import { FirestoreRecoveryReissueStore } from "@uptime402/persistence";
import { reissueFixture } from "./fixtures/reissue.js";
import { reissuePaidRecovery } from "../services/vendor-agent/src/reissue.js";

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("Firestore recovery checkpoints", () => {
  const prefix = `u402resume_${process.pid}_${Date.now().toString(36)}`;
  const firstDb = new Firestore({ projectId: `uptime402-resume-${process.pid}` });
  const secondDb = new Firestore({ projectId: `uptime402-resume-${process.pid}` });
  const first = new FirestoreRecoveryCheckpointStore(firstDb, prefix);
  const second = new FirestoreRecoveryCheckpointStore(secondDb, prefix);
  afterAll(async () => {
    for (const name of ["reissue_approvals", "reissues", "recovery_resources"]) await firstDb.recursiveDelete(firstDb.collection(`${prefix}_${name}`));
    await firstDb.recursiveDelete(firstDb.collection(`${prefix}_recovery_checkpoints`));
    await firstDb.recursiveDelete(firstDb.collection(`${prefix}_operator_captures`));
    await Promise.all([firstDb.terminate(), secondDb.terminate()]);
  });
  it("creates a free lease exactly once across instances without overwriting the expired activation", async () => {
    const f = reissueFixture();
    const value = await reissuePaidRecovery(f.deps, f.approval.approvalId);
    const wrap = (value: unknown) => ({ schemaVersion: "1", recordHash: canonicalHash(value), value });
    const oldRef = firstDb.collection(`${prefix}_recovery_resources`).doc(f.original.activationId);
    await oldRef.create(wrap(f.original));
    await firstDb.collection(`${prefix}_reissue_approvals`).doc(f.approval.approvalId).create(wrap(f.approval));
    const a = new FirestoreRecoveryReissueStore(firstDb, prefix), b = new FirestoreRecoveryReissueStore(secondDb, prefix);
    const before = canonicalHash((await oldRef.get()).data());
    const values = await Promise.all([a.createOnce(value), b.createOnce(value)]);
    expect(values[0]).toEqual(values[1]);
    expect(await b.readForPayment(f.approval.paymentId)).toEqual(value);
    expect(canonicalHash((await oldRef.get()).data())).toBe(before);
    expect((await firstDb.collection(`${prefix}_reissues`).get()).size).toBe(1);
    const changed = structuredClone(value); changed.resource.expiresAt = "2026-10-22T05:25:00.000Z";
    expect(await a.createOnce(changed)).toEqual(value);
    await firstDb.collection(`${prefix}_reissues`).doc(f.approval.paymentId).update({ "value.resource.expiresAt": changed.resource.expiresAt });
    await expect(b.readForPayment(f.approval.paymentId)).rejects.toThrow("integrity failure");
  });
  it("persists one proof across instances and rejects a changed payment context", async () => {
    const contextHash = canonicalHash({ paymentId: "paid-1" });
    const records = await Promise.all([
      first.putOnce("reservation-1", "proof", { contextHash, value: { outcome: "first" } }),
      second.putOnce("reservation-1", "proof", { contextHash, value: { outcome: "second" } }),
    ]);
    expect(records[0]).toEqual(records[1]);
    expect(await second.get("reservation-1", "proof")).toEqual(records[0]);
    await expect(first.putOnce("reservation-1", "proof", { contextHash: canonicalHash("other payment"), value: null })).rejects.toThrow("context conflict");
  });
  it("rejects storage tampering before returning continuation data", async () => {
    const contextHash = canonicalHash("context");
    await first.putOnce("reservation-2", "input", { contextHash, value: { safe: true } });
    const id = canonicalHash({ reservationId: "reservation-2", stage: "input" }).slice(7);
    await firstDb.collection(`${prefix}_recovery_checkpoints`).doc(id).update({ "record.value": { safe: false } });
    await expect(second.get("reservation-2", "input")).rejects.toThrow("integrity failure");
  });
  it("atomically appends one completion across instances while preserving original capture bytes", async () => {
    const a = new FirestoreOperatorIncidentCaptureStore(firstDb, `${prefix}_operator_captures`);
    const b = new FirestoreOperatorIncidentCaptureStore(secondDb, `${prefix}_operator_captures`);
    const { input, recovered } = operatorContinuationFixture();
    await a.create(input);
    const collection = firstDb.collection(`${prefix}_operator_captures`);
    const original = (await collection.get()).docs[0]!;
    const originalHash = canonicalHash(original.data());
    await Promise.all([
      a.appendRecovery(input.runSlot, recovered, "2026-10-22T00:01:00.000Z"),
      b.appendRecovery(input.runSlot, recovered, "2026-10-22T00:02:00.000Z"),
    ]);
    const latest = await b.read(input.runSlot, input.requestHash);
    expect(latest.latest.result.primary).toEqual(recovered);
    expect(latest.original).toEqual(input.response);
    expect(latest.latest.result.denials).toBeNull();
    expect(canonicalHash((await original.ref.get()).data())).toBe(originalHash);
    expect((await original.ref.collection("continuations").get()).size).toBe(1);
    expect(await a.getContinuation(input.runSlot, input.requestHash, canonicalHash(input.response.result.primary))).toEqual(latest.latest);
    await expect(a.getContinuation(input.runSlot, input.requestHash, canonicalHash("another action"))).rejects.toThrow("action/capture binding");
    await expect(b.appendRecovery(input.runSlot, { ...recovered, correlationId: "wrong-correlation" }, "2026-10-22T00:03:00.000Z")).rejects.toThrow("binding mismatch");
    await original.ref.collection("continuations").doc("recovered").update({ parentResponseHash: canonicalHash("tampered") });
    await expect(a.read(input.runSlot, input.requestHash)).rejects.toThrow("history binding");
  });
});
