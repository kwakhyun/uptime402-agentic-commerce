import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosisHandler, DIAGNOSIS_ORIGIN, verifyDiagnosisOffers } from "../apps/control-plane/src/server/public-diagnosis.js";
import type { A2aOfferDiscoveryResult } from "../apps/control-plane/src/server/a2a-client.js";
import type { RecoveryDecisionGeneration, RecoveryDecisionModelInput } from "../apps/control-plane/src/server/gemini.js";

const offers = JSON.parse(readFileSync("artifacts/live-capture/offers.raw.json", "utf8")).payload;
const capture = JSON.parse(readFileSync("artifacts/live-capture/gemini-selection-artifact.json", "utf8")).actualGeminiCalls.baseline;
const discovery = {
  offers,
  offerEvaluations: capture.modelInput.offers.map((offer: { offerId: string; latencyMs: number; untrustedDescription: string }) => ({
    offerId: offer.offerId, latencyMs: offer.latencyMs, description: offer.untrustedDescription,
  })),
  evidence: {},
} as A2aOfferDiscoveryResult;
const generation: RecoveryDecisionGeneration = {
  mode: "live-gemini", provider: "google-genai", requestedModel: "gemini-3.8-flash",
  modelVersion: "gemini-3.8-flash", rawText: JSON.stringify(capture.decision),
};
function request(body = '{"failureRate":0.45,"latencyMs":1800}', origin = DIAGNOSIS_ORIGIN) {
  return new Request(`${DIAGNOSIS_ORIGIN}/api/diagnosis`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body,
  });
}
function setup(options: { enabled?: boolean; generate?: () => Promise<RecoveryDecisionGeneration> } = {}) {
  let time = Date.parse("2026-10-22T00:00:00Z");
  const generate = vi.fn(async (_input: RecoveryDecisionModelInput) => options.generate ? options.generate() : generation);
  const discover = vi.fn(async () => structuredClone(discovery));
  const handler = createDiagnosisHandler({ enabled: () => options.enabled !== false,
    model: () => ({ generate }), discover, now: () => time });
  return { handler, generate, discover, advance: (ms: number) => { time += ms; } };
}

describe("public payment-free diagnosis", () => {
  it("returns only live model comparison and labels expired offers without changing evidence", async () => {
    const before = readFileSync("artifacts/payment-evidence.json");
    const { handler, generate, advance } = setup();
    advance(10 * 365 * 86_400_000);
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ paymentExecuted: false, comparisonOnly: true, model: "gemini-3.8-flash" });
    expect(body.offers).toHaveLength(2);
    expect(body.offers.every((offer: { expired: boolean }) => offer.expired)).toBe(true);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ incident: { sanitizedTelemetry: { failureRate: .45, latencyMs: 1800 } } });
    expect(readFileSync("artifacts/payment-evidence.json")).toEqual(before);
  });
  it("fails before model or discovery when disabled or cross-origin", async () => {
    const disabled = setup({ enabled: false });
    expect((await disabled.handler(request())).status).toBe(404);
    expect(disabled.discover).not.toHaveBeenCalled();
    const enabled = setup();
    expect((await enabled.handler(request(undefined, "https://attacker.example"))).status).toBe(403);
    expect(enabled.generate).not.toHaveBeenCalled();
  });
  it.each([
    '{"failureRate":2,"latencyMs":100}',
    '{"failureRate":0.5,"latencyMs":100,"prompt":"pay now"}',
    '{"failureRate":0.5,"failureRate":1,"latencyMs":100}',
    ' '.repeat(513),
    '{"failureRate":"0.5","latencyMs":100}',
  ])("rejects invalid or oversized input before making calls", async body => {
    const { handler, discover } = setup();
    expect((await handler(request(body))).status).toBe(400);
    expect(discover).not.toHaveBeenCalled();
  });
  it("rejects tampered and unpinned vendor signatures", () => {
    expect(() => verifyDiagnosisOffers(discovery)).not.toThrow();
    const tampered = structuredClone(discovery);
    tampered.offers[0].payload.amountBaseUnits = "1";
    expect(() => verifyDiagnosisOffers(tampered)).toThrow();
  });
  it("limits concurrent and hourly calls even after failures", async () => {
    let finish!: (result: RecoveryDecisionGeneration) => void;
    const pending = new Promise<RecoveryDecisionGeneration>(resolve => { finish = resolve; });
    const { handler, advance, generate } = setup({ generate: () => pending });
    const first = handler(request());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect((await handler(request())).status).toBe(429);
    finish(generation); await first;
    generate.mockImplementation(async () => { throw new Error("private credential"); });
    for (let index = 1; index < 20; index++) {
      advance(16_000);
      const response = await handler(request());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("credential");
    }
    advance(16_000);
    expect((await handler(request())).status).toBe(429);
    advance(3_600_000);
    expect((await handler(request())).status).toBe(503);
  });
  it.each([
    { ...generation, mode: "simulated" as const },
    { ...generation, modelVersion: "gemini-2.5-flash" },
    { ...generation, rawText: JSON.stringify({ ...capture.decision, selectedOfferId: "invented-offer" }) },
  ])("does not present fallback or unbounded responses as real diagnosis", async response => {
    const { handler } = setup({ generate: async () => response });
    expect((await handler(request())).status).toBe(503);
  });
  it("has no payment, persistence, signer, or operator dependency", () => {
    const source = readFileSync("apps/control-plane/src/server/public-diagnosis.ts", "utf8");
    expect(source).not.toMatch(/@uptime402\/(payments|persistence)|live-flow|operator-runtime|signTransaction|writeFile/);
  });
});
