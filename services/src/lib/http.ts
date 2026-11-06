import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

export type AuthedEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

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

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Wrap a handler: map HttpError to a response and hide unexpected errors. */
export function handler<E>(fn: (event: E) => Promise<APIGatewayProxyResultV2>) {
  return async (event: E): Promise<APIGatewayProxyResultV2> => {
    try {
      return await fn(event);
    } catch (err) {
      if (err instanceof HttpError) return json(err.statusCode, { message: err.message });
      console.error(err);
      return json(500, { message: 'Internal error' });
    }
  };
}
