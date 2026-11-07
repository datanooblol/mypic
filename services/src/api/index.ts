/**
 * Single Lambda behind the HTTP API. API Gateway has already verified the Cognito JWT;
 * routing is by the route key ("METHOD /path/{param}") defined in infra ApiStack.
 */
import { HttpError, json, type AuthedEvent, type Result } from '../lib/http';
import { downloadMany, downloadMedia, getMedia, listMedia, reprocessMedia } from './media';
import { createAlbum, deleteAlbum, getAlbumView, listAlbumItems, listAlbums, updateAlbum } from './albums';
import { getMe } from './me';
import { listTagItems, listTags } from './tags';
import { batch, emptyTrash, listTrash, restoreOne, trashOne } from './trash';
import { abortUpload, completeUpload, createUpload, partUrls } from './uploads';

type Route = (event: AuthedEvent) => Promise<Result>;

export const routes: Record<string, Route> = {
  'GET /me': getMe,
  'POST /uploads': createUpload,
  'POST /uploads/{mediaId}/parts': partUrls,
  'POST /uploads/{mediaId}/complete': completeUpload,
  'DELETE /uploads/{mediaId}': abortUpload,
  'GET /media': listMedia,
  'GET /media/{mediaId}': getMedia,
  'GET /media/{mediaId}/download': downloadMedia,
  'POST /media/{mediaId}/reprocess': reprocessMedia,
  'DELETE /media/{mediaId}': trashOne,
  'POST /media/{mediaId}/restore': restoreOne,
  'POST /media/batch': batch,
  'POST /media/download': downloadMany,
  'GET /trash': listTrash,
  'DELETE /trash': emptyTrash,
  'GET /albums': listAlbums,
  'POST /albums': createAlbum,
  'GET /albums/{albumId}': getAlbumView,
  'PATCH /albums/{albumId}': updateAlbum,
  'DELETE /albums/{albumId}': deleteAlbum,
  'GET /albums/{albumId}/items': listAlbumItems,
  'GET /tags': listTags,
  'GET /tags/{tag}/items': listTagItems,
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
