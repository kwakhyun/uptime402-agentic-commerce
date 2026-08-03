import {
  getProductionOperatorBoundary,
  operatorErrorResponse,
  operatorJsonResponse,
} from "../../../../../src/server/operator-runtime";
import {
  OperatorLiveUiHttpError,
  assertSameOriginBodylessLiveRequest,
  hashServerOwnedIncidentRunBinding,
  projectLiveOperatorUiResponse,
  readServerOwnedIncidentRequest,
  requireLiveOperatorUiConfig,
} from "../../../../../src/server/operator-ui-trigger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const config = requireLiveOperatorUiConfig(process.env);
    assertSameOriginBodylessLiveRequest(request, config.controlPlaneOrigin);
    const boundary = getProductionOperatorBoundary();
    const identity = await boundary.authenticate(
      request.headers.get("authorization"),
    );
    const serverRequest = await readServerOwnedIncidentRequest(config);
    const runBindingHash = hashServerOwnedIncidentRunBinding(serverRequest);
    const result = await boundary.runIncident(identity, serverRequest);
    const response = operatorJsonResponse(
      projectLiveOperatorUiResponse(result, runBindingHash),
    );
    response.headers.set("x-uptime402-evidence-level", "live-unverified");
    return response;
  } catch (error) {
    if (error instanceof OperatorLiveUiHttpError) {
      return operatorJsonResponse({ error: error.code }, error.status);
    }
    return operatorErrorResponse(error);
  }
}
