import { Firestore } from "@google-cloud/firestore";
import { canonicalHash } from "@uptime402/domain";
import { FirestoreRecoveryCheckpointStore } from "@uptime402/persistence";
import { afterAll, describe, expect, it } from "vitest";

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("Firestore recovery checkpoints", () => {
  const prefix = `u402resume_${process.pid}_${Date.now().toString(36)}`;
  const firstDb = new Firestore({ projectId: `uptime402-resume-${process.pid}` });
  const secondDb = new Firestore({ projectId: `uptime402-resume-${process.pid}` });
  const first = new FirestoreRecoveryCheckpointStore(firstDb, prefix);
  const second = new FirestoreRecoveryCheckpointStore(secondDb, prefix);
  afterAll(async () => {
    await firstDb.recursiveDelete(firstDb.collection(`${prefix}_recovery_checkpoints`));
    await Promise.all([firstDb.terminate(), secondDb.terminate()]);
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
});
