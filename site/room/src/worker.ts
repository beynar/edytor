/**
 * The public demo room behind the live editor on the docs landing page.
 *
 * One room per UTC day (`demo-YYYY-MM-DD`), so the shared document resets
 * daily; any other room is refused. Anyone may edit: `authorize` accepts a
 * guest whose id the browser keeps in localStorage and sends as `?guest=`,
 * so a reconnect keeps the identity the room bound its client ids to. Only
 * the docs origins (and localhost) may connect.
 */
import { DocumentRoom, requestedReplica, routeDocumentSocket } from 'edytor/cloudflare';

export { DocumentRoom };

type Env = {
	ROOMS: DurableObjectNamespace<DocumentRoom>;
	ALLOWED_ORIGINS: string;
};

const DEMO_ROOM = /^demo-\d{4}-\d{2}-\d{2}$/;
const GUEST = /^[a-z0-9-]{8,64}$/;

const originAllowed = (origin: string | null, env: Env) => {
	if (!origin) return false;
	const { hostname } = new URL(origin);
	if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
	return env.ALLOWED_ORIGINS.split(',')
		.map((allowed) => allowed.trim())
		.filter(Boolean)
		.includes(origin);
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/health') return new Response('ok');
		const match = /^\/rooms\/([^/]+)$/.exec(url.pathname);
		if (!match) return new Response('not found', { status: 404 });
		const room = decodeURIComponent(match[1]);
		if (!DEMO_ROOM.test(room)) return new Response('unknown room', { status: 404 });
		if (!originAllowed(request.headers.get('Origin'), env)) {
			return new Response('origin not allowed', { status: 403 });
		}
		return routeDocumentSocket(request, env.ROOMS, room, async (request) => {
			const guest = new URL(request.url).searchParams.get('guest') ?? '';
			if (!GUEST.test(guest)) return null;
			return { userId: `guest:${guest}`, replica: requestedReplica(request) };
		});
	}
} satisfies ExportedHandler<Env>;
