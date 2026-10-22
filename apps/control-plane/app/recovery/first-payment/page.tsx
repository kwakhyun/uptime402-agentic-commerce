import Link from "next/link";
import { loadFreeRecoveryEvidence } from "../../../src/server/free-recovery-evidence";

export const dynamic = "force-dynamic";
export default async function FirstPaymentRecoveryPage() {
  const { data } = await loadFreeRecoveryEvidence();
  const grant = data.reissue;
  const expired = Date.now() >= Date.parse(grant.resource.expiresAt);
  const time = (value: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
  const rows = [
    ["추가 결제", "0 USDC · 새 거래 없음"],
    ["기존 거래", "0.015 Devnet USDC · finalized"],
    ["복구 확인", time(data.recovery.recoveryOutcome.payload.recoveredAt) + " KST"],
    ["실제 RPC 응답", `getHealth=ok · Devnet genesis 일치 · ${grant.resource.rpcEndpoint}`],
    ["두 RPC 호출 시간", `${data.recovery.healthProbe.details.latencyMs.toFixed(1)} ms`],
    ["기존 예약", "committed · 추가 예산 차감 없음"],
    ["재발급 후 지갑", `${Number(data.walletAfter.payerUsdcBaseUnits) / 1_000_000} Devnet USDC`],
    ["원본 접근권 만료", time(grant.originalResource.expiresAt) + " KST · 기존 기록 보존"],
    ["재발급 접근권 만료", time(grant.resource.expiresAt) + ` KST · ${expired ? "만료됨" : "검증 당시 발급한 접근 기간"}`],
  ];
  return <main style={{ maxWidth: 880, margin: "0 auto", padding: "40px 20px", lineHeight: 1.65, overflowWrap: "anywhere" }}>
    <Link href="/">← Uptime402</Link>
    <p style={{ marginTop: 32 }}>첫 거래 후속 검증 기록</p>
    <h1 style={{ fontSize: "clamp(26px, 5vw, 38px)", lineHeight: 1.3 }}>추가 결제 없이 RPC 복구 완료</h1>
    <p>만료된 접근권을 별도 승인으로 한 번 재발급하고 실제 RPC 응답을 확인했습니다. 원본 결제 영수증, 만료 기록과 실패 기록을 보존하고 새 영수증과 복구 서명을 추가했습니다.</p>
    <dl>{rows.map(([label, value]) => <div key={label} style={{ padding: "16px 0", borderBottom: "1px solid #8885" }}>
      <dt style={{ fontWeight: 700 }}>{label}</dt><dd style={{ margin: "4px 0 0" }}>{value}</dd>
    </div>)}</dl>
    <p>기록된 시각의 복구 검증입니다. 접근권은 10분 뒤 만료되며, 만료된 결제 허용 기간은 연장하지 않았습니다. 자체 공급자의 읽기 전용 Devnet RPC와 주입 장애 시나리오를 검증했습니다.</p>
    <p><a href={`https://explorer.solana.com/tx/${grant.resource.txSignature}?cluster=devnet`} target="_blank" rel="noreferrer">기존 거래 확인</a>{" · "}<a href="/api/evidence/first-payment-recovery">서명과 검증 증거 JSON</a></p>
  </main>;
}
