// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveDiagnosis } from "../apps/control-plane/components/live-diagnosis.js";

afterEach(() => { vi.unstubAllGlobals(); });
describe("public diagnosis form", () => {
  it("submits only numeric metrics, escapes model output and keeps payment out of the flow", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const fetchMock = vi.fn(async () => Response.json({
      model: "gemini-3.8-flash", modelVersion: "gemini-3.8-flash", diagnosedAt: "2026-10-22T00:00:00Z",
      diagnosis: '<script>steal()</script>', rationale: "Compare only", selectedOfferId: "rpc-recovery-standard",
      paymentExecuted: false, comparisonOnly: true,
      offers: [{ offerId: "rpc-recovery-standard", priceUsdc: "0.015000", latencyMs: 180,
        expiresAt: "2026-08-03T00:00:00Z", expired: true }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(LiveDiagnosis)));
      expect(fetchMock).not.toHaveBeenCalled();
      await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      expect(fetchMock.mock.calls).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledWith("/api/diagnosis", expect.objectContaining({
        method: "POST", body: JSON.stringify({ failureRate: .45, latencyMs: 1800 }),
      }));
      expect(container.querySelector("script")).toBeNull();
      expect(container.textContent).toContain('<script>steal()</script>');
      expect(container.textContent).toContain("만료된 견적");
      expect(container.textContent).toContain("기존 검증 기록도 바꾸지 않습니다");
      fetchMock.mockImplementation(async () => Response.json({ error: "rate" }, { status: 429, headers: { "Retry-After": "15" } }));
      await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("15초");
      expect(container.textContent).not.toContain('<script>steal()</script>');
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
