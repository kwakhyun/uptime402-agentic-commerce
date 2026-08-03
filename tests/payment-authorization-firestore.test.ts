import { Firestore } from "@google-cloud/firestore";
import { afterAll, describe, expect, it } from "vitest";

import {
  DEVNET_USDC_MINT,
  MandateUnsignedSchema,
  canonicalHash,
  computeMandateHash,
  type Mandate,
} from "@uptime402/domain";
import {
  FirestoreTransactionalRepository,
  type ReservationRecord,
} from "@uptime402/persistence";

import type { CachedPaymentAuthorization } from "../services/payment-executor/src/index.js";
import { FirestorePaymentAuthorizationStore } from "../services/payment-executor/src/runtime.js";

const emulatorEnabled = typeof process.env.FIRESTORE_EMULATOR_HOST === "string";
const FAR_FUTURE = "2099-08-03T12:10:00.000Z";
const CHECKED_AT = "2020-08-03T03:10:00.000Z";
const PRINCIPAL = "operator@example.test";
const PAYEE = "SysvarRent111111111111111111111111111111111";

type TestActivation = {
  mandateId: string;
  mandateHash: `sha256:${string}`;
  executionPolicyHash: `sha256:${string}`;
  status: "active" | "revoked";
  version: number;
  updatedAt: string;
  principal: string;
  reason?: string;
};

describe.skipIf(!emulatorEnabled)(
  "Firestore payment authorization release guard (a skip is not verification)",
  () => {
    const collectionPrefix = `u402auth_${process.pid}_${Date.now().toString(36)}`;
    const projectId = `uptime402-authorization-${process.pid}`;
    const firstClient = new Firestore({ projectId });
    const secondClient = new Firestore({ projectId });
    const firstRepository = new FirestoreTransactionalRepository(firstClient, {
      collectionPrefix,
    });
    const secondRepository = new FirestoreTransactionalRepository(secondClient, {
      collectionPrefix,
    });
    const firstStore = new FirestorePaymentAuthorizationStore(firstRepository);
    const secondStore = new FirestorePaymentAuthorizationStore(secondRepository);
    const collectionSuffixes = [
      "mandates",
      "mandate_activations",
      "reservations",
      "reservation_identifiers",
      "budget_counters",
      "audit_events",
      "payment_authorizations",
    ] as const;

    afterAll(async () => {
      for (const suffix of collectionSuffixes) {
        await firstClient.recursiveDelete(
          firstClient.collection(`${collectionPrefix}_${suffix}`),
        );
      }
      await Promise.all([firstClient.terminate(), secondClient.terminate()]);
    });

    function activationReference(mandateId: string) {
      return firstClient
        .collection(`${collectionPrefix}_mandate_activations`)
        .doc(mandateId);
    }

    function makeMandate(caseId: string): Mandate {
      const executionPolicyHash = canonicalHash({ caseId, kind: "execution-policy" });
      const unsigned = MandateUnsignedSchema.parse({
        id: `mandate-${caseId}`,
        subject: "service:payment-authorization-test",
        clusterLabel: "devnet",
        assetMint: DEVNET_USDC_MINT,
        perTransactionLimitBaseUnits: "20000",
        incidentLimitBaseUnits: "50000",
        dailyLimitBaseUnits: "100000",
        allowedRecipients: [PAYEE],
        allowedCapabilities: ["solana-rpc-health"],
        allowedVendorOrigins: ["https://vendor.example.test"],
        allowedAgentCardHashes: [canonicalHash({ caseId, kind: "agent-card" })],
        notBefore: "2020-08-03T03:00:00.000Z",
        expiresAt: FAR_FUTURE,
        nonce: `mandate-nonce-${caseId}`,
        issuerPrincipal: PRINCIPAL,
        issuedAt: "2020-08-03T02:59:00.000Z",
        executionPolicyHash,
        protocolLabel: "internal",
      });
      return {
        ...unsigned,
        mandateHash: computeMandateHash(unsigned),
        attestation: {
          kid: "operator-key-v1",
          algorithm: "EdDSA",
          signature: "T".repeat(88),
        },
      };
    }

    function makeActiveActivation(
      mandate: Mandate,
      version = 1,
      updatedAt = "2020-08-03T03:00:01.000Z",
    ): TestActivation {
      return {
        mandateId: mandate.id,
        mandateHash: mandate.mandateHash as `sha256:${string}`,
        executionPolicyHash: mandate.executionPolicyHash as `sha256:${string}`,
        status: "active",
        version,
        updatedAt,
        principal: PRINCIPAL,
      };
    }

    async function reserve(
      caseId: string,
      mandate: Mandate,
      repository = firstRepository,
    ): Promise<ReservationRecord> {
      const result = await repository.reserveBudget({
        reservationId: `reservation-${caseId}`,
        incidentId: `incident-${caseId}`,
        mandateId: mandate.id,
        paymentId: `payment-${caseId}`,
        nonce: `nonce-${caseId}`,
        idempotencyKey: `idempotency-${caseId}`,
        requestFingerprint: canonicalHash({ caseId, kind: "request" }),
        amountBaseUnits: "1000",
        incidentLimitBaseUnits: "50000",
        dailyLimitBaseUnits: "100000",
        occurredAt: "2020-08-03T03:00:02.000Z",
      });
      if (result.kind !== "reserved") {
        throw new Error(`Expected a fresh reservation, received ${result.kind}`);
      }
      return result.record;
    }

    function makeAuthorization(
      caseId: string,
      mandate: Mandate,
      activation: TestActivation,
      reservation: ReservationRecord,
    ): CachedPaymentAuthorization {
      return {
        reservationId: reservation.reservationId,
        reservationVersion: reservation.version,
        requestFingerprint: reservation.requestFingerprint as `sha256:${string}`,
        paymentId: reservation.paymentId,
        idempotencyKey: reservation.idempotencyKey,
        mandateId: mandate.id,
        mandateHash: mandate.mandateHash as `sha256:${string}`,
        executionPolicyHash: mandate.executionPolicyHash as `sha256:${string}`,
        mandateActivationVersion: activation.version,
        mandateActivationHash: canonicalHash(activation),
        authorizationContextHash: canonicalHash({ caseId, kind: "authorization-context" }),
        authorizationExpiresAt: FAR_FUTURE,
        authorizationPublishedAt: "2020-08-03T03:00:03.000Z",
        paymentSignatureHeader: `payment-signature-${caseId}`,
        signedTransactionSha256: canonicalHash({ caseId, kind: "signed-transaction" }),
        signerMode: "devnet",
      };
    }

    async function setup(caseId: string) {
      const mandate = makeMandate(caseId);
      await firstRepository.putMandate(mandate);
      const activation = makeActiveActivation(mandate);
      await activationReference(mandate.id).set(activation);
      const reservation = await reserve(caseId, mandate);
      const authorization = makeAuthorization(caseId, mandate, activation, reservation);
      return { mandate, activation, reservation, authorization };
    }

    function lookupInput(authorization: CachedPaymentAuthorization) {
      return {
        reservationId: authorization.reservationId,
        authorizationContextHash: authorization.authorizationContextHash,
        requestFingerprint: authorization.requestFingerprint as `sha256:${string}`,
        checkedAt: CHECKED_AT,
      };
    }

    it("publishes once across two instances and releases the one persisted value", async () => {
      const { authorization } = await setup("publish-once");

      const outcomes = await Promise.all([
        firstStore.publishIfActive(authorization),
        secondStore.publishIfActive(authorization),
      ]);

      expect(outcomes.sort()).toEqual(["existing", "stored"]);
      const persisted = await firstClient
        .collection(`${collectionPrefix}_payment_authorizations`)
        .where("value.reservationId", "==", authorization.reservationId)
        .get();
      expect(persisted.size).toBe(1);
      await expect(firstStore.getReleasable(lookupInput(authorization))).resolves.toEqual({
        kind: "releasable",
        authorization,
      });
      await expect(secondStore.getReleasable(lookupInput(authorization))).resolves.toEqual({
        kind: "releasable",
        authorization,
      });
    });

    it("denies an already-cached authorization after mandate revocation", async () => {
      const { mandate, activation, authorization } = await setup("revoke-cache");
      await expect(firstStore.publishIfActive(authorization)).resolves.toBe("stored");
      const revoked: TestActivation = {
        ...activation,
        status: "revoked",
        version: activation.version + 1,
        updatedAt: "2020-08-03T03:01:00.000Z",
        reason: "operator kill switch",
      };
      await activationReference(mandate.id).set(revoked);

      await expect(secondStore.getReleasable(lookupInput(authorization))).resolves.toEqual({
        kind: "not_releasable",
      });
      await expect(secondStore.publishIfActive(authorization)).resolves.toBe("not_releasable");
    });

    it("blocks revoke-to-rearm ABA while allowing an authorization bound to the new activation", async () => {
      const { mandate, activation, authorization } = await setup("activation-aba");
      await expect(firstStore.publishIfActive(authorization)).resolves.toBe("stored");
      const revoked: TestActivation = {
        ...activation,
        status: "revoked",
        version: activation.version + 1,
        updatedAt: "2020-08-03T03:01:00.000Z",
        reason: "rotate activation",
      };
      await activationReference(mandate.id).set(revoked);
      const rearmed = makeActiveActivation(
        mandate,
        revoked.version + 1,
        "2020-08-03T03:02:00.000Z",
      );
      await activationReference(mandate.id).set(rearmed);

      await expect(secondStore.getReleasable(lookupInput(authorization))).resolves.toEqual({
        kind: "not_releasable",
      });

      const newReservation = await reserve("activation-aba-new", mandate, secondRepository);
      const newAuthorization = makeAuthorization(
        "activation-aba-new",
        mandate,
        rearmed,
        newReservation,
      );
      await expect(secondStore.publishIfActive(newAuthorization)).resolves.toBe("stored");
      await expect(firstStore.getReleasable(lookupInput(newAuthorization))).resolves.toMatchObject({
        kind: "releasable",
        authorization: {
          mandateActivationVersion: rearmed.version,
          mandateActivationHash: canonicalHash(rearmed),
        },
      });
    });

    it("blocks release and republish after the bound reservation changes state and version", async () => {
      const { reservation, authorization } = await setup("reservation-change");
      await expect(firstStore.publishIfActive(authorization)).resolves.toBe("stored");
      const transitioned = await secondRepository.transitionReservation(
        reservation.reservationId,
        ["reserved"],
        "submitted",
        "2020-08-03T03:01:00.000Z",
      );
      expect(transitioned.state).toBe("submitted");
      expect(transitioned.version).toBe(reservation.version + 1);

      await expect(secondStore.getReleasable(lookupInput(authorization))).resolves.toEqual({
        kind: "not_releasable",
      });
      await expect(firstStore.publishIfActive(authorization)).resolves.toBe("not_releasable");
    });

    it("blocks a same-version activation whose canonical hash was tampered", async () => {
      const { mandate, activation, authorization } = await setup("activation-tamper");
      await expect(firstStore.publishIfActive(authorization)).resolves.toBe("stored");
      const tampered: TestActivation = {
        ...activation,
        principal: "attacker@example.test",
      };
      expect(canonicalHash(tampered)).not.toBe(authorization.mandateActivationHash);
      await activationReference(mandate.id).set(tampered);

      await expect(secondStore.getReleasable(lookupInput(authorization))).resolves.toEqual({
        kind: "not_releasable",
      });
      await expect(secondStore.publishIfActive(authorization)).resolves.toBe("not_releasable");
    });
  },
);
