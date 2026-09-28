/**
 * The Worker in front of the SHIPPED room (`edytor/cloudflare`, from
 * source): the deployment shape README "Server coordinator" documents.
 *
 * - `GET /health` → `ready`
 * - `/rooms/<name>` (WebSocket upgrade) → `routeDocumentSocket` to the
 *   room's Durable Object (`env.ROOM.getByName(name)`) — the URL shape the
 *   shipped `WebsocketProvider` dials (`serverUrl = ws://host/rooms`).
 * - `POST /rooms/<name>/compact` → `DocumentRoom.compact()` over RPC.
 *
 * TEST-ONLY `authorize`: it trusts the query string (`?user=` — default
 * `anon`, `denied` is refused —, `?replica=`, `?access=read`). A real host
 * verifies a session or token here.
 */
import {
	DocumentRoom,
	requestedReplica,
	routeDocumentSocket,
	type AuthorizeDocumentSocket,
	type DocumentRoomEnv
} from '../../src/lib/cloudflare/index.js';

export { DocumentRoom };

export type Env = DocumentRoomEnv & { ROOM: DurableObjectNamespace<DocumentRoom> };

export const ROOM_ROUTE = /^\/rooms\/([^/]+)(\/compact)?\/?$/;

export const authorizeFromQuery: AuthorizeDocumentSocket = (request) => {
	const query = new URL(request.url).searchParams;
	const userId = query.get('user') ?? 'anon';
	if (userId === 'denied') return null;
	return {
		userId,
		replica: requestedReplica(request),
		readOnly: query.get('access') === 'read'
	};
};

export const routeRoom = async (request: Request, env: Env): Promise<Response> => {
	const url = new URL(request.url);
	if (url.pathname === '/health') return new Response('ready');
	const match = ROOM_ROUTE.exec(url.pathname);
	if (!match) return new Response('not found', { status: 404 });
	const name = decodeURIComponent(match[1]);
	if (match[2]) {
		if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
		return Response.json(await env.ROOM.getByName(name).compact());
	}
	return routeDocumentSocket(request, env.ROOM, name, authorizeFromQuery);
};

export default {
	fetch: (request: Request, env: Env) => routeRoom(request, env)
} satisfies ExportedHandler<Env>;
