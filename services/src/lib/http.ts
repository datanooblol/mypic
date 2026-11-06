import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import type { z } from 'zod';

export type AuthedEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type Result = APIGatewayProxyResultV2;

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Cognito `sub` from the verified JWT. This is the only trusted source of userId. */
export function userIdOf(event: AuthedEvent): string {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || !sub) throw new HttpError(401, 'Unauthorized');
  return sub;
}

export function json(statusCode: number, body: unknown): Result {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Parse and validate a JSON body; 400 on failure. */
export function parseBody<S extends z.ZodType>(event: AuthedEvent, schema: S): z.infer<S> {
  let raw: unknown;
  try {
    const text = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `Invalid request: ${issue?.path.join('.') || 'body'} ${issue?.message ?? ''}`.trim());
  }
  return parsed.data;
}

export function pathParam(event: AuthedEvent, name: string): string {
  const value = event.pathParameters?.[name];
  if (!value) throw new HttpError(400, `Missing path parameter: ${name}`);
  return value;
}
