import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

type Claims = Record<string, string>;
const response = (statusCode: number, body: object, requestId: string) => ({ statusCode, headers: { 'content-type': 'application/json', 'x-request-id': requestId, 'strict-transport-security': 'max-age=31536000; includeSubDomains' }, body: JSON.stringify(body) });
function claims(event: Parameters<APIGatewayProxyHandlerV2>[0]): Claims { return (event.requestContext.authorizer?.jwt?.claims ?? {}) as Claims; }

export const handler: APIGatewayProxyHandlerV2 = async event => {
  const requestId = event.requestContext.requestId || randomUUID();
  const user = claims(event);
  if (!user.sub) return response(401, { code: 'UNAUTHENTICATED', requestId }, requestId);
  // Tenant resolution must query Membership using Cognito sub. Never trust tenantId/companyId from the browser.
  if (event.rawPath === '/v1/health') return response(200, { status: 'ok', environment: process.env.APP_ENV, requestId }, requestId);
  if (event.rawPath === '/v1/dashboard') return response(501, { code: 'NOT_IMPLEMENTED', requestId, message: 'Connect DashboardService after database membership guard is complete.' }, requestId);
  return response(404, { code: 'NOT_FOUND', requestId }, requestId);
};
