import {
  getProductionOperatorBoundary,
  operatorErrorResponse,
  operatorJsonResponse,
  readStrictOperatorJson,
  requireOperatorMutationsEnabled,
} from "../../../../../../src/server/operator-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ mandateId: string }> },
): Promise<Response> {
  try {
    requireOperatorMutationsEnabled();
    const boundary = getProductionOperatorBoundary();
    const identity = await boundary.authenticate(
      request.headers.get("authorization"),
    );
    const body = await readStrictOperatorJson(request);
    const { mandateId } = await context.params;
    const result = await boundary.revokeMandate(identity, mandateId, body);
    return operatorJsonResponse(result);
  } catch (error) {
    return operatorErrorResponse(error);
  }
}
