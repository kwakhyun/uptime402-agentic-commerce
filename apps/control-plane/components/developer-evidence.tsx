"use client";

import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { Code } from "@phosphor-icons/react/Code";
import { FileText } from "@phosphor-icons/react/FileText";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useState } from "react";

import type {
  MissionControlDemoState,
  MissionTimelineStep,
  VerifiedPaymentEvidenceView,
} from "./demo-state";
import { LiveOperatorTrigger } from "./live-operator-trigger";
import { VerifiedEvidence } from "./verified-evidence";
import type { LiveOperatorUiConfig } from "../src/live-ui-contract";

const statusLabel: Record<MissionTimelineStep["state"], string> = {
  waiting: "대기",
  running: "확인 중",
  "local-simulated": "로컬 미리보기",
  "devnet-verified": "검증됨",
  denied: "자동 차단",
};

interface DeveloperEvidenceProps {
  demoState: MissionControlDemoState;
  devnetVerified: boolean;
  liveOperatorConfig: LiveOperatorUiConfig;
  liveUnverified: boolean;
  runComplete: boolean;
  runStarted: boolean;
  selectedStepId: MissionTimelineStep["id"];
  verifiedEvidence: VerifiedPaymentEvidenceView | null;
}

export function DeveloperEvidence({
  demoState,
  devnetVerified,
  liveOperatorConfig,
  liveUnverified,
  runComplete,
  runStarted,
  selectedStepId,
  verifiedEvidence,
}: DeveloperEvidenceProps) {
  const [open, setOpen] = useState(false);
  const overCapDenial = demoState.denials.find(
    (denial) => denial.rule === "perTransactionCap",
  );
  const replayDenial = demoState.denials.find(
    (denial) => denial.rule !== "perTransactionCap",
  );

  return (
    <details
      className="developer-evidence"
      id="developer-evidence"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="developer-summary__icon"><Code size={19} aria-hidden="true" /></span>
        <span>
          <strong>개발자용 원본 증거 보기</strong>
          <small>10단계 실행 trace, x402 headers, 정책 판정, 온체인 delta</small>
        </span>
        <CaretDown className="developer-summary__caret" size={18} aria-hidden="true" />
      </summary>
      <div className="developer-evidence__body">
        <section className="trace-panel" aria-labelledby="trace-heading">
          <header>
            <FileText size={20} aria-hidden="true" />
            <div><h3 id="trace-heading">실행 trace</h3><p>읽기 전용 evidence adapter가 표시하는 시간순 기록입니다.</p></div>
          </header>
          <ol className="trace-list">
            {demoState.timeline.map((step, index) => (
              <li className={step.id === selectedStepId && runStarted && !runComplete ? "is-current" : ""} key={step.id}>
                <span className="trace-number">{String(index + 1).padStart(2, "0")}</span>
                <div><span>{step.protocolLabel}</span><strong>{step.title}</strong><p>{step.detail}</p></div>
                <div className={`trace-status trace-status--${step.state}`}><span>{statusLabel[step.state]}</span><time>{step.timeLabel}</time></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="denial-panel" aria-labelledby="denial-heading">
          <header><ShieldCheck size={20} aria-hidden="true" /><h3 id="denial-heading">자동 차단 증거</h3></header>
          <div className="denial-grid">
            {[overCapDenial, replayDenial].filter((denial) => denial !== undefined).map((denial) => (
              <article key={denial.id}>
                <span>{denial.rule === "perTransactionCap" ? "한도 초과" : "Nonce replay"}</span>
                <strong>{denial.title}</strong>
                <code>transactionCreated:{String(denial.transactionCreated)}</code>
                <code>txSignature:{String(denial.txSignature)}</code>
                <small>{denial.requestedValue} · policy {denial.policyValue}</small>
              </article>
            ))}
          </div>
        </section>

        {verifiedEvidence ? <VerifiedEvidence evidence={verifiedEvidence} /> : (
          <section className="unverified-panel">
            <WarningCircle size={22} weight="fill" aria-hidden="true" />
            <div>
              <strong>{liveUnverified ? "LIVE UNVERIFIED" : "LOCAL SIMULATION"}</strong>
              <p>검증된 payment-evidence.json과 verification-report.json이 고정되기 전에는 transaction, Explorer, receipt를 verified로 표시하지 않습니다.</p>
            </div>
          </section>
        )}

        {!devnetVerified ? (
          <details className="operator-controls">
            <summary>Capture-only operator controls · Google OIDC <CaretDown size={16} aria-hidden="true" /></summary>
            <LiveOperatorTrigger
              config={liveOperatorConfig}
              onRunStarted={() => setOpen(true)}
            />
          </details>
        ) : null}
      </div>
    </details>
  );
}
