import { readFile } from "node:fs/promises";

import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
} from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import {
  narrowVerifyOnlyFacilitator,
  safeVerifyOnlyCliFailure,
} from "../scripts/diagnose-facilitator-verify.js";

describe("facilitator verify-only diagnostic CLI", () => {
  it("narrows a richer transport to verify only", async () => {
    const verify = vi.fn(async (): Promise<VerifyResponse> => ({
      isValid: false,
      invalidReason: "transaction_simulation_failed",
      invalidMessage: "BlockhashNotFound",
    }));
    const dangerousTransport = {
      verify,
      settle: vi.fn(),
      sendTransaction: vi.fn(),
    };
    const diagnosticTransport = narrowVerifyOnlyFacilitator(dangerousTransport);

    expect(Object.keys(diagnosticTransport)).toEqual(["verify"]);
    expect("settle" in diagnosticTransport).toBe(false);
    expect("sendTransaction" in diagnosticTransport).toBe(false);

    const payload = { x402Version: 2 } as PaymentPayload;
    const requirements = { scheme: "exact" } as PaymentRequirements;
    await diagnosticTransport.verify(payload, requirements);

    expect(verify).toHaveBeenCalledOnce();
    expect(dangerousTransport.settle).not.toHaveBeenCalled();
    expect(dangerousTransport.sendTransaction).not.toHaveBeenCalled();
  });

  it("renders only an allowlisted failure and never reflects thrown secret text", () => {
    const rawSecret = "Bearer eyJhbGciOi-secret-payment-payload";
    const rendered = JSON.stringify(
      safeVerifyOnlyCliFailure("verification", new Error(rawSecret)),
    );

    expect(rendered).toContain('"failure":"verification_failed"');
    expect(rendered).toContain('"settlementCalled":false');
    expect(rendered).not.toContain(rawSecret);
    expect(rendered).not.toContain("Bearer");
  });

  it("contains no settlement or transaction-submission call site", async () => {
    const source = await readFile(
      new URL("../scripts/diagnose-facilitator-verify.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/\.settle\s*\(/u);
    expect(source).not.toMatch(/sendTransaction\s*\(/u);
    expect(source).not.toContain("PAYMENT-SIGNATURE");
  });
});
