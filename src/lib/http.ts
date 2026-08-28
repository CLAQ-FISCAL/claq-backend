import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'AppError';
  }
}

export type ApiResponse = { statusCode: number; headers: Record<string, string>; body: string };

export function jsonResponse(statusCode: number, body: object, requestId: string): ApiResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'x-request-id': requestId,
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

export function errorResponse(err: unknown, requestId: string): ApiResponse {
  if (err instanceof AppError) {
    return jsonResponse(err.status, { code: err.code, message: err.message, requestId }, requestId);
  }
  console.error(JSON.stringify({ level: 'error', requestId, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }));
  return jsonResponse(500, { code: 'INTERNAL', requestId, message: 'Unexpected server error.' }, requestId);
}

export function parseJsonBody(body: string | undefined): Record<string, unknown> {
  if (!body || body.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error('not an object');
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }
}

export function requireString(body: Record<string, unknown>, field: string, max = 200): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') throw new AppError(422, 'INPUT_INVALID', `Field '${field}' is required.`);
  if (value.length > max) throw new AppError(422, 'INPUT_INVALID', `Field '${field}' exceeds ${max} characters.`);
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, field: string, max = 200): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new AppError(422, 'INPUT_INVALID', `Field '${field}' must be a string.`);
  if (value.length > max) throw new AppError(422, 'INPUT_INVALID', `Field '${field}' exceeds ${max} characters.`);
  return value.trim();
}

export function header(event: APIGatewayProxyEventV2WithJWTAuthorizer, name: string): string | undefined {
  const headers = event.headers ?? {};
  return headers[name] ?? headers[name.toLowerCase()];
}
