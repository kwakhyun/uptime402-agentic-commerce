import {
  getProductionOperatorBoundary,
  operatorErrorResponse,
  operatorJsonResponse,
  readStrictOperatorJson,
  requireOperatorMutationsEnabled,
} from "../../../../../src/server/operator-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    requireOperatorMutationsEnabled();
    const boundary = getProductionOperatorBoundary();
    const identity = await boundary.authenticate(
      request.headers.get("authorization"),
    );
    const body = await readStrictOperatorJson(request);
    const result = await boundary.armMandate(identity, body);
    return operatorJsonResponse(result, result.idempotentReplay ? 200 : 201);
  } catch (error) {
    return operatorErrorResponse(error);
  }
}
