import { resolve } from "node:path";

import { MissionControl } from "../components/mission-control";
import { parseLiveOperatorUiConfig } from "../src/server/operator-ui-trigger";
import {
  loadMissionControlStateForDeployment,
  parseUiEvidenceDeploymentStage,
} from "../src/server/ui-evidence";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const artifactRoot = process.env.UPTIME402_ARTIFACT_ROOT?.trim() || resolve(process.cwd(), "artifacts");
  const stage = parseUiEvidenceDeploymentStage(process.env.UPTIME402_UI_EVIDENCE_STAGE);
  const expectedEvidenceSha256 = process.env.UPTIME402_UI_EVIDENCE_SHA256?.trim();
  const expectedVerificationReportSha256 =
    process.env.UPTIME402_UI_VERIFICATION_REPORT_SHA256?.trim();
  const initialState = await loadMissionControlStateForDeployment({
    artifactRoot,
    stage,
    ...(expectedEvidenceSha256 ? { expectedEvidenceSha256 } : {}),
    ...(expectedVerificationReportSha256 ? { expectedVerificationReportSha256 } : {}),
  });
  const liveOperatorConfig = parseLiveOperatorUiConfig(process.env);

  return (
    <MissionControl
      initialState={initialState}
      liveOperatorConfig={liveOperatorConfig}
    />
  );
}
