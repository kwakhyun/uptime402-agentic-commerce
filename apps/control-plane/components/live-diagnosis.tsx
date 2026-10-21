"use client";

import { useState, type FormEvent } from "react";
import type { DiagnosisResult } from "../src/diagnosis-contract";

export function LiveDiagnosis() {
  const [failureRate, setFailureRate] = useState("45");
  const [latency, setLatency] = useState("1800");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DiagnosisResult | null>(null);
  const [error, setError] = useState("");

  async function diagnose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/diagnosis", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ failureRate: Number(failureRate) / 100, latencyMs: Number(latency) }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) {
        setError(response.status === 429
          ? `호출이 몰렸습니다. ${response.headers.get("Retry-After") ?? "15"}초 후 다시 시도해 주세요.`
          : "현재 진단을 완료할 수 없습니다. 잠시 후 다시 시도해 주세요. 결제는 실행되지 않았습니다.");
        return;
      }
      setResult(await response.json() as DiagnosisResult);
    } catch {
      setError("응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요. 결제는 실행되지 않았습니다.");
    } finally { setBusy(false); }
  }

  return <section className="live-diagnosis" id="live-diagnosis" aria-labelledby="live-diagnosis-title">
    <p className="live-diagnosis__eyebrow">실제 모델 호출 · 결제 없음</p>
    <h2 id="live-diagnosis-title">Gemini 3.8 Flash로 직접 진단하기</h2>
    <p>관측한 RPC 오류율과 응답 지연을 입력하면 Gemini가 원인을 진단하고 공급자의 두 견적을 비교합니다. 아래 값은 예시이며, 서비스에 연결해 장애를 자동 수집하지는 않습니다.</p>
    <form onSubmit={event => { void diagnose(event); }}>
      <div className="live-diagnosis__inputs">
        <label>오류율 (%)<input type="number" min="0" max="100" step="1" required value={failureRate} disabled={busy} onChange={event => setFailureRate(event.target.value)} /></label>
        <label>응답 지연 (ms)<input type="number" min="0" max="60000" step="1" required value={latency} disabled={busy} onChange={event => setLatency(event.target.value)} /></label>
      </div>
      <button className="replay-button" type="submit" disabled={busy}>{busy ? "Gemini가 진단하고 있습니다…" : "진단과 견적 비교 실행"}</button>
    </form>
    <p className="live-diagnosis__note">진단 결과는 이 화면에만 표시됩니다. 구매, 예산 예약, 결제, 복구 실행은 하지 않으며 기존 검증 기록도 바꾸지 않습니다.</p>
    <div aria-live="polite" aria-busy={busy}>
      {error && <p role="alert">{error}</p>}
      {result && <div className="live-diagnosis__result">
        <p>{result.modelVersion} · {new Date(result.diagnosedAt).toLocaleString("ko-KR")} · 새 결제 없음</p>
        <h3>진단 결과</h3><p>{result.diagnosis}</p>
        <h3>견적 비교</h3><p>{result.rationale}</p>
        <ul>{result.offers.map(offer => <li key={offer.offerId}>
          <strong>{offer.offerId}{offer.offerId === result.selectedOfferId ? " — Gemini 선택" : ""}</strong>
          <span>{offer.priceUsdc} USDC · 공급자 제시 지연 {offer.latencyMs ?? "미제공"}ms</span>
          <span>{offer.expired ? "만료된 견적 · 참고 비교용, 현재 구매 불가" : `유효 기한: ${new Date(offer.expiresAt).toLocaleString("ko-KR")}`}</span>
        </li>)}</ul>
        <p>이 결과는 지금 입력한 지표의 분석이며, 아래의 과거 결제 증거와는 별개입니다.</p>
      </div>}
    </div>
  </section>;
}
