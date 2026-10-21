import { canonicalHash } from "@uptime402/domain";
import { describe, expect, it } from "vitest";
import { projectOperatorContinuation } from "../apps/control-plane/src/server/operator-capture.js";
import { operatorContinuationFixture } from "./fixtures/operator-continuation.js";

describe("operator continuation history", () => {
  it("projects completion for export without rewriting the original or creating denial evidence", () => {
    const { input, recovered } = operatorContinuationFixture();
    const original = { schemaVersion: "1", runSlot: input.runSlot, requestHash: input.requestHash,
      capturedAt: input.capturedAt, responseHash: canonicalHash(input.response), value: input.response };
    const before = structuredClone(original);
    const value = { ...input.response, result: { ...input.response.result, primary: recovered } };
    const continuation = { ...original, parentResponseHash: original.responseHash,
      originalPrimaryHash: canonicalHash(input.response.result.primary),
      capturedAt: "2026-10-22T00:01:00.000Z", responseHash: canonicalHash(value), value };
    expect(projectOperatorContinuation(original, continuation)).toEqual(value);
    expect(original).toEqual(before);
    expect(() => projectOperatorContinuation(original, { ...continuation, parentResponseHash: canonicalHash("other") })).toThrow("history binding");
    const changed = structuredClone(continuation);
    changed.value.result.primary = { ...changed.value.result.primary, reservationId: "another-reservation" };
    changed.responseHash = canonicalHash(changed.value);
    expect(() => projectOperatorContinuation(original, changed)).toThrow("payment binding");
  });
});
