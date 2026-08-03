import { Firestore } from "@google-cloud/firestore";
import { afterAll, describe, expect, it } from "vitest";

import { canonicalHash } from "@uptime402/domain";
import {
  FirestoreTransactionalRepository,
  ImmutableRecordConflictError,
  type ReserveBudgetRequest,
} from "@uptime402/persistence";

describe("Firestore persistence construction (no credentials)", () => {
  it("rejects unsafe collection prefixes before performing I/O", () => {
    expect(
      () => new FirestoreTransactionalRepository({} as Firestore, { collectionPrefix: "bad/prefix" }),
    ).toThrow(/collectionPrefix/);
  });
});

const emulatorEnabled = typeof process.env.FIRESTORE_EMULATOR_HOST === "string";

describe.skipIf(!emulatorEnabled)("Firestore emulator integration (a skip is not verification)", () => {
  const collectionPrefix = `u402test_${process.pid}_${Date.now().toString(36)}`;
  const projectId = `uptime402-emulator-${process.pid}`;
  const firstClient = new Firestore({ projectId });
  const secondClient = new Firestore({ projectId });
  const first = new FirestoreTransactionalRepository(firstClient, { collectionPrefix });
  const second = new FirestoreTransactionalRepository(secondClient, { collectionPrefix });
  const collectionSuffixes = [
    "challenges",
    "reservations",
    "reservation_identifiers",
    "budget_counters",
    "denials",
    "audit_events",
    "vendor_claims",
  ] as const;

  afterAll(async () => {
    for (const suffix of collectionSuffixes) {
      await firstClient.recursiveDelete(firstClient.collection(`${collectionPrefix}_${suffix}`));
    }
    await Promise.all([firstClient.terminate(), secondClient.terminate()]);
  });

  const reserveRequest = (index: number): ReserveBudgetRequest => ({
    reservationId: `reservation-${index}`,
    incidentId: "incident-firestore",
    mandateId: "mandate-firestore",
    paymentId: `payment-${index}`,
    nonce: `nonce-${index}`,
    idempotencyKey: `idempotency-${index}`,
    requestFingerprint: canonicalHash({ index }),
    amountBaseUnits: "600",
    incidentLimitBaseUnits: "1000",
    dailyLimitBaseUnits: "1000",
    occurredAt: "2026-08-03T12:05:00+09:00",
  });

  it("atomically prevents overspend across instances", async () => {
    const results = await Promise.all([
      first.reserveBudget(reserveRequest(1)),
      second.reserveBudget(reserveRequest(2)),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["budget_exceeded", "reserved"]);
    const winner = results[0]?.kind === "reserved" ? reserveRequest(1) : reserveRequest(2);
    await expect(second.reserveBudget(winner)).resolves.toMatchObject({ kind: "existing" });
  });

  it("returns a nonce replay before exhausted held budget", async () => {
    const held: ReserveBudgetRequest = {
      ...reserveRequest(20),
      reservationId: "reservation-held-replay",
      incidentId: "incident-held-replay",
      mandateId: "mandate-held-replay",
      paymentId: "payment-held-replay",
      nonce: "nonce-held-replay",
      idempotencyKey: "idempotency-held-replay",
      requestFingerprint: canonicalHash({ held: true }),
      amountBaseUnits: "1000",
    };
    const reserved = await first.reserveBudget(held);
    expect(reserved).toMatchObject({ kind: "reserved" });
    if (reserved.kind !== "reserved") throw new Error("held-budget fixture did not reserve");
    const submitted = await first.transitionReservation(
      reserved.record.reservationId,
      ["reserved"],
      "submitted",
      held.occurredAt,
    );
    await expect(
      first.transitionReservation(submitted.reservationId, ["submitted"], "unknown", held.occurredAt),
    ).resolves.toMatchObject({ state: "unknown" });
    await expect(first.getReservationByNonce(held.nonce)).resolves.toMatchObject({
      reservationId: held.reservationId,
      nonce: held.nonce,
      state: "unknown",
    });

    const replay: ReserveBudgetRequest = {
      ...held,
      reservationId: "reservation-fresh-replay",
      incidentId: "incident-fresh-replay",
      paymentId: "payment-fresh-replay",
      idempotencyKey: "idempotency-fresh-replay",
      requestFingerprint: canonicalHash({ held: false }),
      amountBaseUnits: "1",
    };
    await expect(second.reserveBudget(replay)).resolves.toMatchObject({
      kind: "conflict",
      reason: "nonce",
      existingReservationId: held.reservationId,
    });
    await expect(second.getReservationByIdempotencyKey(replay.idempotencyKey)).resolves.toBeNull();
  });

  it("keeps immutable challenges and rejects replacement", async () => {
    const payload = { x402Version: 2, accepts: [{ scheme: "exact", amount: "20000" }] };
    const challenge = {
      challengeId: "challenge-firestore",
      challengeHash: canonicalHash(payload),
      paymentId: "payment-challenge",
      operationId: "recover-rpc",
      expiresAt: "2026-08-03T12:10:00+09:00",
      capturedAt: "2026-08-03T12:05:00+09:00",
      payload,
    } as const;
    await expect(first.putChallenge(challenge)).resolves.toMatchObject({ kind: "stored" });
    await expect(second.putChallenge(challenge)).resolves.toMatchObject({ kind: "existing" });
    const replacementPayload = { x402Version: 2, accepts: [{ scheme: "exact", amount: "20001" }] };
    await expect(second.putChallenge({
      ...challenge,
      challengeHash: canonicalHash(replacementPayload),
      payload: replacementPayload,
    })).rejects.toBeInstanceOf(ImmutableRecordConflictError);
  });

  it("claims a vendor payment once and never releases ambiguous settling", async () => {
    const request = {
      vendorTenant: "vendor-firestore",
      paymentId: "payment-vendor",
      requestFingerprint: canonicalHash({ request: "bound" }),
      occurredAt: "2026-08-03T12:05:00+09:00",
    };
    const results = await Promise.all([
      first.claimVendorPayment(request),
      second.claimVendorPayment(request),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["acquired", "reconcile_required"]);
    const claim = await first.getVendorPaymentClaim(request.vendorTenant, request.paymentId);
    expect(claim).not.toBeNull();
    const attempted = await first.markVendorSettlementAttempted(
      request.vendorTenant,
      request.paymentId,
      claim!.version,
      "2026-08-03T12:05:01+09:00",
    );
    await expect(
      second.releaseVendorClaimBeforeSubmission(request.vendorTenant, request.paymentId, attempted.version),
    ).resolves.toBe(false);
    await expect(second.claimVendorPayment({ ...request, requestFingerprint: canonicalHash({ request: "other" }) }))
      .resolves.toMatchObject({ kind: "conflict", httpStatus: 409 });
  });
});
