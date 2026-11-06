import type { MeResponse } from '@mypic/shared';
import { json, userIdOf, type AuthedEvent } from '../lib/http';

/** GET /me: current user (storage usage comes later). */
export async function getMe(event: AuthedEvent) {
  const email = event.requestContext.authorizer.jwt.claims.email;
  const body: MeResponse = {
    userId: userIdOf(event),
    email: typeof email === 'string' ? email : undefined,
  };
  return json(200, body);
}
