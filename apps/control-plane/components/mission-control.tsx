"use client";

import Image from "next/image";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { ArrowSquareOut } from "@phosphor-icons/react/ArrowSquareOut";
import { Check } from "@phosphor-icons/react/Check";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { Heartbeat } from "@phosphor-icons/react/Heartbeat";
import { LockKey } from "@phosphor-icons/react/LockKey";
import { Pause } from "@phosphor-icons/react/Pause";
import { Play } from "@phosphor-icons/react/Play";
import { Receipt } from "@phosphor-icons/react/Receipt";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useState } from "react";

import type { MissionControlDemoState } from "./demo-state";
import { DeveloperEvidence } from "./developer-evidence";
import { useRecoveryPlayback } from "./use-recovery-playback";
import type { LiveOperatorUiConfig } from "../src/live-ui-contract";

interface MissionControlProps {
  initialState: MissionControlDemoState;
  liveOperatorConfig: LiveOperatorUiConfig;
}

const RECOVERY_PHASES = [
  { id: 1, label: "장애 감지", protocol: "Incident" },
  { id: 2, label: "복구 옵션 선택", protocol: "Gemini · A2A" },
  { id: 3, label: "정책 확인과 결제", protocol: "Policy · x402" },
  { id: 4, label: "복구 검증", protocol: "Receipt" },
] as const;

function compactDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/u, "").replace(/\.$/u, "") : value;
}

export function MissionControl({ initialState, liveOperatorConfig }: MissionControlProps) {
  const {
    completionCount,
    currentPhase,
    demoState,
    phaseClass,
    phaseState,
    playbackLabel,
    replayProgressPercent,
    runComplete,
    runPaused,
    runStarted,
    selectedStep,
    selectedStepId,
    togglePlayback,
  } = useRecoveryPlayback(initialState);
  const [decisionView, setDecisionView] = useState<"baseline" | "counterfactual">("baseline");
  const verifiedEvidence = demoState.paymentEvidence.level === "devnet-verified"
    ? demoState.paymentEvidence
    : null;
  const devnetVerified = verifiedEvidence !== null;
  const liveUnverified = demoState.evidenceLevel === "live-unverified";
  const paidAmountLabel = verifiedEvidence ? compactDecimal(verifiedEvidence.amountUsdc) : null;
  const recoverySecondsLabel = verifiedEvidence
    ? (verifiedEvidence.recoveryTimeMs / 1_000).toFixed(3)
    : null;
  const displayedOfferId = decisionView === "baseline"
    ? demoState.modelDecision.selectedOfferId
    : demoState.modelDecision.counterfactualOfferId;
  const displayedOffer = demoState.offers.find((offer) => offer.offerId === displayedOfferId);
  const toBaseUnits = (value: string) => BigInt(value.split(".")[0]!) * 1_000_000n + BigInt((value.split(".")[1] ?? "").padEnd(6, "0"));
  const displayedOfferOverCap = displayedOffer ? toBaseUnits(displayedOffer.priceUsdc) > toBaseUnits(demoState.mandate.perTransactionCapUsdc) : false;
  const evidencePrefix = devnetVerified ? "" : liveUnverified ? "검증 대기 · " : "예시 · ";
  const decisionConditions = decisionView === "baseline" ? demoState.modelDecision.baselineConditions : demoState.modelDecision.counterfactualConditions;
  const decisionStartedLabel = verifiedEvidence?.recoveryStartedAt.replace("T", " ") ?? "검증 대기";
  const incidentTimeLabel = initialState.timeline.find((step) => step.id === "incident")?.timeLabel ?? "--:--.---";
  const recoveredTimeLabel = initialState.timeline.find((step) => step.id === "recovery")?.timeLabel ?? "--:--.---";
  const handlePlaybackToggle = () => {
    if (!runStarted || runComplete) setDecisionView("baseline");
    togglePlayback();
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#recovery-flow">복구 과정으로 건너뛰기</a>

      <header className="app-header">
        <a className="brand" href="#overview" aria-label="Uptime402 홈">
          <Image src="/icon.svg" width={36} height={36} alt="" priority />
          <span>Uptime402</span>
        </a>
        <nav aria-label="페이지 섹션">
          <a href="#overview">개요</a>
          <a href="#recovery-flow">복구 과정</a>
          <a href="#developer-evidence">검증 증거</a>
        </nav>
        <span className={`header-status ${devnetVerified ? "is-verified" : "is-unverified"}`}>
          {devnetVerified ? <CheckCircle size={17} weight="fill" aria-hidden="true" /> : <WarningCircle size={17} weight="fill" aria-hidden="true" />}
          {devnetVerified ? "DEVNET VERIFIED" : demoState.environmentLabel}
        </span>
      </header>

      <main className="recovery-report">
        <section className="report-hero" id="overview" aria-labelledby="report-title">
          <h1 id="report-title">
            {devnetVerified ? (
              <>판단 기록 후 <strong>{recoverySecondsLabel}초</strong> 만에 라우트 활성화를 확인했습니다</>
            ) : liveUnverified ? (
              <>장애 복구 증거를 <strong>수집 중</strong>입니다</>
            ) : (
              <>안전한 자동 복구 흐름을 <strong>미리 확인</strong>합니다</>
            )}
          </h1>
          <p className="report-summary">
            {devnetVerified
              ? `Gemini가 두 복구 옵션을 비교했습니다. Uptime402는 미리 설정된 정책에 따라 건별 승인 없이 ${paidAmountLabel} USDC를 결제하고 라우트 활성화 기록을 검증했습니다.`
              : "Gemini 진단, A2A 견적 비교, 정책 판정과 x402 결제 흐름을 네 단계로 확인할 수 있습니다."}
          </p>
          <div className="hero-action-group">
            <button
              className={`replay-button${!runStarted ? " is-ready" : ""}`}
              type="button"
              onClick={handlePlaybackToggle}
            >
              {runStarted && !runPaused && !runComplete
                ? <Pause size={19} weight="fill" aria-hidden="true" />
                : <Play size={19} weight="fill" aria-hidden="true" />}
              <span>{playbackLabel}</span>
            </button>
            <span className="read-only-note">
              <LockKey size={16} aria-hidden="true" />
              {devnetVerified ? "읽기 전용 · 새 결제 없음" : liveUnverified ? "LIVE UNVERIFIED · 검증 전" : "로컬 미리보기 · 결제 없음"}
            </span>
          </div>
          <div className="playback-status" role="status" aria-live="polite">
            {runStarted ? (
              <>
                <span>{runComplete ? "확인 완료" : `${Math.min(completionCount + 1, demoState.timeline.length)} / ${demoState.timeline.length}`}</span>
                <strong>{runComplete ? devnetVerified ? "실행 기록 재생이 끝났습니다." : "예시 흐름을 모두 확인했습니다." : selectedStep?.title}</strong>
              </>
            ) : (
              <><span>안내</span><strong>{devnetVerified ? "재생 버튼을 누르면 저장된 실행 기록을 순서대로 볼 수 있습니다." : "재생 버튼은 예시 흐름을 보여줍니다. 실제로 결제를 실행하거나 결과를 검증하지는 않습니다."}</strong></>
            )}
          </div>
        </section>

        <section
          className={`replay-progress${runComplete ? " is-complete" : ""}`}
          aria-labelledby="replay-progress-title"
          aria-busy={runStarted && !runPaused && !runComplete}
        >
          <div className="replay-progress__header">
            <div>
              <span>{runStarted ? `현재 ${Math.max(currentPhase, 1)} / 4단계` : "4단계 자동 복구"}</span>
              <strong id="replay-progress-title">
                {!runStarted
                  ? "재생을 시작하면 판단과 결제 과정을 순서대로 보여드립니다."
                  : runComplete
                    ? devnetVerified ? "실행 기록 재생이 끝났습니다." : "예시 흐름을 모두 확인했습니다."
                    : runPaused
                      ? `일시정지 · ${selectedStep?.title ?? "복구 기록"}`
                      : selectedStep?.title}
              </strong>
            </div>
            <output aria-label="재생 진행률">{replayProgressPercent}%</output>
          </div>
          <div
            className="replay-progress__track"
            role="progressbar"
            aria-label="자동 복구 재생 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={replayProgressPercent}
          >
            <span style={{ width: `${replayProgressPercent}%` }} />
          </div>
          <ol className="replay-progress__stages" aria-label="자동 복구 단계">
            {RECOVERY_PHASES.map((phase) => {
              const state = phaseState(phase.id);
              const status = state === "complete"
                ? "완료"
                : state === "active"
                  ? runPaused ? "일시정지" : "진행 중"
                  : "대기";
              return (
                <li
                  className={`replay-progress__stage is-${state}`}
                  aria-current={state === "active" ? "step" : undefined}
                  key={phase.id}
                >
                  <span className="replay-progress__marker" aria-hidden="true">
                    {state === "complete" ? (
                      <Check size={15} weight="bold" />
                    ) : state === "active" ? (
                      runPaused
                        ? <Pause size={13} weight="fill" />
                        : <CircleNotch className="stage-spinner" size={16} weight="bold" />
                    ) : (
                      phase.id
                    )}
                  </span>
                  <span>
                    <small>{phase.protocol}</small>
                    <strong>{phase.label}</strong>
                  </span>
                  <em>{status}</em>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="health-transition" aria-label="서비스 상태 변화">
          <div className="health-state health-state--before">
            <WarningCircle size={22} weight="fill" aria-hidden="true" />
            <div><span>장애 감지</span><strong>{demoState.dependency.label}</strong></div>
            <small>health probe 실패</small>
          </div>
          <ArrowRight className="health-arrow" size={22} aria-hidden="true" />
          <div className={`health-state ${devnetVerified ? "health-state--after" : "health-state--pending"}`}>
            {devnetVerified ? <CheckCircle size={22} weight="fill" aria-hidden="true" /> : <WarningCircle size={22} aria-hidden="true" />}
            <div><span>{devnetVerified ? "라우트 활성화 확인" : "복구 검증 대기"}</span><strong>{devnetVerified ? "route activation verified" : "결과 미확인"}</strong></div>
            <small>{devnetVerified ? `${recoverySecondsLabel}초` : "preview"}</small>
          </div>
          <dl className="health-timing">
            <div><dt>장애 발생 기록</dt><dd>{devnetVerified ? incidentTimeLabel : "예시 장애"}</dd></div>
            <div><dt>판단 기록</dt><dd>{decisionStartedLabel}</dd></div>
            <div><dt>활성화 확인</dt><dd>{devnetVerified ? recoveredTimeLabel : "미확인"}</dd></div>
            <div><dt>판단 후 경과 시간</dt><dd>{devnetVerified ? `${recoverySecondsLabel}초` : "검증 대기"}</dd></div>
          </dl>
        </section>

        <p className="evidence-scope-note">
          {devnetVerified ? "이 기록에서 확인한 범위는 결제와 Firestore 라우트 활성화까지입니다. 당시 대체 RPC에 실제로 요청을 보내 성공했는지는 측정하지 않았습니다." : "아래는 실행 흐름 안내입니다. 결제, 라우트 활성화와 RPC 정상 여부는 아직 검증되지 않았습니다."}
        </p>

        <ol className="recovery-sections" id="recovery-flow">
          <li className={`recovery-section${phaseClass(1)}`}>
            <div className="section-index" aria-hidden="true">01</div>
            <div className="section-title">
              <span>Incident</span>
              <h2>{evidencePrefix}장애 감지</h2>
            </div>
            <div className="section-content incident-content">
              <div className="incident-signal">
                <Heartbeat size={22} aria-hidden="true" />
                <div>
                  <strong>{devnetVerified ? "기본 RPC 장애 기록" : "기본 RPC 장애 시나리오"}</strong>
                  <p>{devnetVerified ? "민감한 정보를 제거한 장애 신호를 Gemini에 전달했습니다." : "정제된 장애 신호만 모델에 전달하는 흐름입니다."}</p>
                </div>
              </div>
              <dl className="compact-facts">
                <div><dt>장애 ID</dt><dd>{demoState.incidentId}</dd></div>
                <div><dt>필요 기능</dt><dd>{demoState.mandate.capability}</dd></div>
              </dl>
            </div>
          </li>

          <li className={`recovery-section${phaseClass(2)}`}>
            <div className="section-index" aria-hidden="true">02</div>
            <div className="section-title">
              <span>Gemini + A2A</span>
              <h2>{evidencePrefix}Gemini의 두 복구 옵션 비교</h2>
            </div>
            <div className="section-content offer-comparison">
              <div className="comparison-toolbar" aria-label="Gemini 판단 조건">
                <div>
                  <ShieldCheck size={18} aria-hidden="true" />
                  <span>{demoState.modelDecision.modeLabel}</span>
                </div>
                <div className="condition-switch">
                  <button
                    type="button"
                    className={decisionView === "baseline" ? "is-selected" : ""}
                    onClick={() => setDecisionView("baseline")}
                    aria-pressed={decisionView === "baseline"}
                  >{devnetVerified ? "실제 실행 조건" : "예시 조건"}</button>
                  <button
                    type="button"
                    className={decisionView === "counterfactual" ? "is-selected" : ""}
                    onClick={() => setDecisionView("counterfactual")}
                    aria-pressed={decisionView === "counterfactual"}
                  >{devnetVerified ? "장애가 심한 조건" : "장애가 가벼운 조건"}</button>
                </div>
              </div>
              <div className="offer-table" role="table" aria-label="A2A 복구 견적 비교">
                <div className="offer-table__head" role="row">
                  <span role="columnheader">복구 옵션</span>
                  <span role="columnheader">비용</span>
                  <span role="columnheader">공급자가 제시한 응답 시간</span>
                  <span role="columnheader">판단</span>
                </div>
                {demoState.offers.map((offer) => {
                  const selected = offer.offerId === displayedOfferId;
                  return (
                    <div className={`offer-row${selected ? " is-selected" : ""}`} role="row" key={offer.offerId}>
                      <span role="cell"><strong>{offer.offerId}</strong><small>{offer.vendorLabel}</small></span>
                      <span role="cell">{compactDecimal(offer.priceUsdc)} USDC</span>
                      <span role="cell">{offer.quotedLatencyMs === undefined ? devnetVerified ? "수치 미포함" : "예시 견적" : `${offer.quotedLatencyMs}ms (공급자 제시)`}</span>
                      <span role="cell">{selected ? <><Check size={15} weight="bold" aria-hidden="true" /> Gemini 선택</> : "비교 대상"}</span>
                    </div>
                  );
                })}
              </div>
              <p className="decision-conditions">{decisionConditions ?? (devnetVerified ? "이 증거 자료에는 상세 장애 조건이 포함되어 있지 않습니다." : "조건에 따라 선택이 달라지는 예시입니다. 실제 모델을 호출하지 않습니다.")}</p>
              <p className="decision-note">
                {decisionView === "baseline" ? demoState.modelDecision.rationale : demoState.modelDecision.counterfactualResult}
              </p>
              <p className={`comparison-policy ${displayedOfferOverCap ? "is-denied" : "is-allowed"}`} role="status">
                {displayedOfferOverCap ? `${compactDecimal(displayedOffer!.priceUsdc)} USDC는 건별 한도 ${compactDecimal(demoState.mandate.perTransactionCapUsdc)} USDC를 초과합니다. Gemini가 선택해도 정책 검사에서 차단되어 결제되지 않습니다.` : "결제 전에는 수신자, 만료 시각, 중복 요청 여부도 확인합니다."}
              </p>
            </div>
          </li>

          <li className={`recovery-section${phaseClass(3)}`}>
            <div className="section-index" aria-hidden="true">03</div>
            <div className="section-title">
              <span>Policy + x402</span>
              <h2>{devnetVerified ? `${paidAmountLabel} USDC 결제가 정책 검사를 통과했습니다` : `${evidencePrefix}결제 전 정책 판정`}</h2>
            </div>
            <div className="section-content policy-content">
              <div className={`policy-callout${devnetVerified ? "" : " is-pending"}`}>
                <ShieldCheck size={26} weight="fill" aria-hidden="true" />
                <div>
                  <span>{devnetVerified ? "정책에 따른 자동 결제" : "설정된 정책으로 검증 예정"}</span>
                  <strong>{paidAmountLabel ? `${paidAmountLabel} USDC ≤ ${compactDecimal(demoState.mandate.perTransactionCapUsdc)} USDC` : `건별 한도 ${compactDecimal(demoState.mandate.perTransactionCapUsdc)} USDC`}</strong>
                  <p>{devnetVerified ? "최초 결제 권한 설정 후에는 건별 승인이나 지갑 팝업 없이 결제 서명을 첨부해 x402 요청을 다시 보냈습니다." : "사전에 부여한 결제 권한과 정책 조건을 모두 충족한 요청만 실행합니다."}</p>
                  <small>{devnetVerified ? "한도 초과 요청과 중복 요청은 트랜잭션을 만들기 전에 차단했습니다." : "한도 초과와 중복 요청을 차단하도록 설계된 흐름입니다."}</small>
                </div>
              </div>
            </div>
          </li>

          <li className={`recovery-section${phaseClass(4)}`}>
            <div className="section-index" aria-hidden="true">04</div>
            <div className="section-title">
              <span>Recovery receipt</span>
              <h2>{devnetVerified ? "서명 영수증과 라우트 활성화를 검증했습니다" : `${evidencePrefix}영수증과 라우트 검증`}</h2>
            </div>
            <div className="section-content receipt-content">
              <div className="receipt-status">
                <Receipt size={24} aria-hidden="true" />
                <div>
                  <span>Vendor-signed fulfillment receipt</span>
                  <strong>{verifiedEvidence ? "영수증 서명과 요청의 일치 여부 확인 완료" : "검증 자료 대기"}</strong>
                  <p>{devnetVerified ? "결제 후 라우트 문서의 무결성과 활성화 상태를 확인한 기록입니다." : "결제된 리소스와 실제 적용 결과의 검증 증거를 기다립니다."}</p>
                </div>
                {verifiedEvidence ? <CheckCircle size={22} weight="fill" aria-label="검증 완료" /> : <WarningCircle size={22} weight="fill" aria-label="검증 대기" />}
              </div>
              {verifiedEvidence ? (
                <>
                  <div className="receipt-meta">
                    <span>{paidAmountLabel} USDC</span>
                    <span>{demoState.cluster.label}</span>
                    <strong>{verifiedEvidence.confirmationStatus}</strong>
                    <a href={verifiedEvidence.explorerUrl} target="_blank" rel="noopener noreferrer">
                      Solana Explorer <ArrowSquareOut size={15} aria-hidden="true" />
                    </a>
                  </div>
                  <code className="receipt-transaction">Tx · {verifiedEvidence.transactionSignature}</code>
                </>
              ) : null}
            </div>
          </li>
        </ol>

        <DeveloperEvidence
          demoState={demoState}
          devnetVerified={devnetVerified}
          liveOperatorConfig={liveOperatorConfig}
          liveUnverified={liveUnverified}
          runComplete={runComplete}
          runStarted={runStarted}
          selectedStepId={selectedStepId}
          verifiedEvidence={verifiedEvidence}
        />

        <footer className="report-footer">
          <span>Uptime402 · An outage does not wait for procurement.</span>
          <span>{demoState.cluster.label} · {demoState.cluster.caip2}</span>
        </footer>
      </main>
    </div>
  );
}
