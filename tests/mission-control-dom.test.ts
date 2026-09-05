// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionControl } from "../apps/control-plane/components/mission-control.js";
import { createLiveUnverifiedDemoState, createLocalDemoState, type MissionControlDemoState } from "../apps/control-plane/components/demo-state.js";
import { loadVerifiedMissionControlState } from "../apps/control-plane/src/server/ui-evidence.js";

let verified: MissionControlDemoState;
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const artifactRoot = resolve("artifacts");
  const hash = async (name: string) => `sha256:${createHash("sha256").update(await readFile(resolve(artifactRoot, name))).digest("hex")}`;
  verified = await loadVerifiedMissionControlState({ artifactRoot, expectedEvidenceSha256: await hash("payment-evidence.json"), expectedVerificationReportSha256: await hash("verification-report.json") });
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(state: MissionControlDemoState) {
  await act(async () => root.render(createElement(MissionControl, { initialState: state, liveOperatorConfig: { mode: "disabled" } })));
}
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
  expect(result, `Missing button: ${label}`).toBeDefined();
  return result!;
}
async function click(label: string) { await act(async () => button(label).click()); }

describe("mission-control rendered behavior", () => {
  it.each(["local", "capture"])("keeps %s results unverified before and after preview playback", async (stage) => {
    vi.useFakeTimers();
    await render(stage === "local" ? createLocalDemoState() : createLiveUnverifiedDemoState());
    expect(container.textContent).toContain("결과 미확인");
    expect(container.textContent).not.toContain("복구 완료");
    expect(container.textContent).not.toContain("service healthy");
    expect(container.querySelector(".health-state--after")).toBeNull();
    expect(container.querySelector('a[href*="explorer.solana.com"]')).toBeNull();
    await click("실행 과정 재생");
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(container.textContent).toContain("결과 미확인");
    expect(container.textContent).toContain("예시 흐름을 모두 확인했습니다");
  });

  it("labels the measured interval and the historical route-only evidence", async () => {
    await render(verified);
    expect(container.querySelector("h1")?.textContent).toContain("판단 기록 후 9.340초");
    expect(container.querySelector(".health-timing")?.textContent).toContain("11:18:01.000Z");
    expect(container.textContent).toContain("당시 대체 RPC에 실제로 요청을 보내 성공했는지는 측정하지 않았습니다");
    expect(container.textContent).toContain("오류율 45%, 응답 지연 1.8초");
    expect(container.querySelector(".developer-evidence__body")).toBeNull();
  });

  it("switches the actual conditions, selected offer and over-cap explanation together", async () => {
    await render(verified);
    await click("장애가 심한 조건");
    expect(button("장애가 심한 조건").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".offer-row.is-selected")?.textContent).toContain("rpc-recovery-emergency");
    expect(container.textContent).toContain("오류율 100%, 응답 지연 12초");
    expect(container.querySelector(".comparison-policy")?.textContent).toContain("정책 검사에서 차단되어 결제되지 않습니다");
    await click("실제 실행 조건");
    expect(container.querySelector(".offer-row.is-selected")?.textContent).toContain("rpc-recovery-standard");
  });

  it("pauses, resumes, completes, and resets playback without generating a payment", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await render(verified);
    await click("실행 과정 재생");
    await act(async () => { vi.advanceTimersByTime(2_000); });
    const progress = () => container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow");
    expect(progress()).toBe("20");
    await click("재생 일시정지");
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(progress()).toBe("20");
    await click("재생 계속");
    await act(async () => { vi.advanceTimersByTime(8_000); });
    expect(progress()).toBe("100");
    await click("처음부터 다시 보기");
    expect(progress()).toBe("0");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
