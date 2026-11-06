/**
 * Single Lambda behind the HTTP API. API Gateway has already verified the Cognito JWT;
 * routing is by the route key ("METHOD /path/{param}") defined in infra ApiStack.
 */
import { HttpError, json, type AuthedEvent, type Result } from '../lib/http';
import { downloadMedia, listMedia } from './media';
import { getMe } from './me';
import { abortUpload, completeUpload, createUpload, partUrls } from './uploads';

type Route = (event: AuthedEvent) => Promise<Result>;

export const routes: Record<string, Route> = {
  'GET /me': getMe,
  'POST /uploads': createUpload,
  'POST /uploads/{mediaId}/parts': partUrls,
  'POST /uploads/{mediaId}/complete': completeUpload,
  'DELETE /uploads/{mediaId}': abortUpload,
  'GET /media': listMedia,
  'GET /media/{mediaId}/download': downloadMedia,
};

export async function handler(event: AuthedEvent): Promise<Result> {
  const route = routes[event.routeKey];
  if (!route) return json(404, { message: 'Not found' });
  try {
    return await route(event);
  } catch (err) {
    if (err instanceof HttpError) return json(err.statusCode, { message: err.message });
    console.error(JSON.stringify({ routeKey: event.routeKey, error: String(err), stack: (err as Error)?.stack }));
    return json(500, { message: 'Internal error' });
  }
}
