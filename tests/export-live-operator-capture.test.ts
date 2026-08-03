import { describe, expect, it } from "vitest";

import { canonicalHash } from "@uptime402/domain";

import { validateStoredOperatorCapture } from "../scripts/export-live-operator-capture.js";

const result = {
  primary: {
    outcome: "recovered" as const,
    transactionCreated: true,
    txSignature: "2".repeat(64),
    selectedOffer: {
      payload: { offerId: "offer-a", amountBaseUnits: "15000" },
    },
  },
  denials: null,
  denialBindings: null,
  denialBindingHashes: null,
};

const response = {
  schemaVersion: "1" as const,
  separation: "application-role" as const,
  idempotentReplay: false as const,
  result,
};

function envelope() {
  return {
    schemaVersion: "1" as const,
    runSlot: "finalist-demo-test",
    requestHash: `sha256:${"1".repeat(64)}` as const,
    capturedAt: "2026-08-03T10:00:00.000Z",
    responseHash: canonicalHash(response),
    value: response,
  };
}

describe("live operator capture export binding", () => {
  it("returns only a fresh hash-bound response", () => {
    expect(
      validateStoredOperatorCapture({
        raw: envelope(),
        expectedRunSlot: "finalist-demo-test",
        expectedRequestHash: `sha256:${"1".repeat(64)}`,
      }),
    ).toEqual(response);
  });

  it("rejects response mutation and run-slot drift", () => {
    const changed = envelope();
    changed.value.result.primary.outcome = "denied" as never;
    expect(() =>
      validateStoredOperatorCapture({
        raw: changed,
        expectedRunSlot: "finalist-demo-test",
        expectedRequestHash: `sha256:${"1".repeat(64)}`,
      }),
    ).toThrow();
    expect(() =>
      validateStoredOperatorCapture({
        raw: envelope(),
        expectedRunSlot: "another-slot",
        expectedRequestHash: `sha256:${"1".repeat(64)}`,
      }),
    ).toThrow();
  });
});
