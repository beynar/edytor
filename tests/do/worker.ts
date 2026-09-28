/**
 * TEST FIXTURE — the Worker in front of {@link Room}.
 *
 * - `GET /health` → `ready`
 * - `/rooms/<name>` (WebSocket upgrade) → the room's Durable Object,
 *   `env.ROOM.getByName(name)`. This is the URL shape the shipped
 *   `WebsocketProvider` dials: `${serverUrl}/${roomName}` with
 *   `serverUrl = ws://host/rooms`.
 * - `POST /rooms/<name>/compact` → test-only compaction hook.
 */
import { Room, type RoomEnv } from './room';

export { Room };

export type Env = RoomEnv & { ROOM: DurableObjectNamespace<Room> };

export const ROOM_ROUTE = /^\/rooms\/([^/]+)(\/compact)?\/?$/;

export const routeRoom = async (request: Request, env: Env): Promise<Response> => {
	const url = new URL(request.url);
	if (url.pathname === '/health') return new Response('ready');
	const match = ROOM_ROUTE.exec(url.pathname);
	if (!match) return new Response('not found', { status: 404 });
	const room = env.ROOM.getByName(decodeURIComponent(match[1]));
	if (match[2]) {
		if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
		return Response.json(await room.compact());
	}
	if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
		return new Response('expected a websocket upgrade', { status: 426 });
	}
	return room.fetch(request);
};

export default {
	fetch: (request: Request, env: Env) => routeRoom(request, env)
} satisfies ExportedHandler<Env>;
