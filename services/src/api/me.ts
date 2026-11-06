import { handler, json, userIdOf, type AuthedEvent } from '../lib/http';

/** GET /me: who am I (placeholder; storage usage comes later). */
export const main = handler(async (event: AuthedEvent) => {
  const claims = event.requestContext.authorizer.jwt.claims;
  return json(200, {
    userId: userIdOf(event),
    email: claims.email,
  });
});
