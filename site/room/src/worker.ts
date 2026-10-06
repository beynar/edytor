/**
 * The public demo room behind the live editor on the docs landing page.
 *
 * One room per UTC day (`demo-YYYY-MM-DD`), so the shared document resets
 * daily: only today's room is open (and yesterday's for the first hour
 * after midnight, so an open page reconnects); any other room is refused.
 * Anyone may edit: `authorize` accepts a
 * guest whose id the browser keeps in localStorage and sends as `?guest=`,
 * so a reconnect keeps the identity the room bound its client ids to. Only
 * the docs origins (and localhost) may connect.
 *
 * A refused dial is accepted, then closed (`4404` for a closed room, `4403`
 * for another origin): a browser sees an HTTP error at the upgrade as a
 * bare `1006`, and a page left open past the reset would redial forever.
 *
 * Each room keeps its version history in the `HISTORY` KV namespace (two
 * versions a day, UTC, kept 30 days); deleted content is purged after the
 * same 30 days.
 */
import {
	DocumentRoom as Room,
	closedSocket,
	kvHistory,
	requestedReplica,
	routeDocumentSocket,
	type DocumentNamespace,
	type HistoryOptions,
	type KVLike
} from 'edytor/cloudflare';
import { isOpenDemoRoom } from './rooms';

type Env = {
	ROOMS: DocumentNamespace;
	HISTORY: KVLike;
	ALLOWED_ORIGINS: string;
};

/** The demo's room: the shipped one, with its history in `HISTORY` (the class keeps its name). */
export class DocumentRoom extends Room<Env> {
	protected override history(): HistoryOptions {
		return { store: kvHistory(this.env.HISTORY), retentionDays: 30, timeZone: 'UTC' };
	}
}

const GUEST = /^[a-z0-9-]{8,64}$/;

const originAllowed = (origin: string | null, env: Env) => {
	if (!origin) return false;
	let hostname: string;
	try {
		hostname = new URL(origin).hostname;
	} catch {
		return false;
	}
	if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
	return env.ALLOWED_ORIGINS.split(',')
		.map((allowed) => allowed.trim())
		.filter(Boolean)
		.includes(origin);
};

/** A refusal: a final close for a WebSocket upgrade, the HTTP `status` otherwise. */
const refuse = (request: Request, status: 403 | 404, reason: string): Response =>
	request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
		? closedSocket(4000 + status, reason)
		: new Response(reason, { status });

const roomOf = (encoded: string): string | null => {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return null;
	}
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/health') return new Response('ok');
		const match = /^\/rooms\/([^/]+)$/.exec(url.pathname);
		if (!match) return refuse(request, 404, 'not found');
		const room = roomOf(match[1]);
		if (room === null || !isOpenDemoRoom(room)) return refuse(request, 404, 'unknown room');
		if (!originAllowed(request.headers.get('Origin'), env)) {
			return refuse(request, 403, 'origin not allowed');
		}
		return routeDocumentSocket(request, env.ROOMS, room, async (request) => {
			const guest = new URL(request.url).searchParams.get('guest') ?? '';
			if (!GUEST.test(guest)) return null;
			return { userId: `guest:${guest}`, replica: requestedReplica(request) };
		});
	}
} satisfies ExportedHandler<Env>;
