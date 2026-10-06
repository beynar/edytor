/**
 * The site's public demo room (site/room): only the current UTC day's
 * room is open, and the previous day's for the first hour after midnight.
 * A dial the demo refuses (a closed room, another origin) is accepted and
 * closed with a `4xxx` code, which the provider treats as final (FW-16):
 * an HTTP error at the upgrade reaches a browser as `1006`, and the page
 * would redial forever.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom } from '../../src/lib/cloudflare/index.js';
import { slotAt, slotEnd } from '../../src/lib/cloudflare/history.js';
import demo from '../../site/room/src/worker';
import { demoRoomAt, isOpenDemoRoom } from '../../site/room/src/rooms';
import { E, SelfWebSocket, crdt } from './client';

declare global {
	namespace Cloudflare {
		interface Env {
			DEMO: DurableObjectNamespace<DocumentRoom>;
			HISTORY: KVNamespace;
		}
	}
}

const at = (iso: string) => Date.parse(iso);

describe('site demo room', () => {
	it("accepts today's room only, and yesterday's until 01:00 UTC", () => {
		const noon = at('2026-09-29T12:00:00Z');
		expect(isOpenDemoRoom('demo-2026-09-29', noon)).toBe(true);
		expect(isOpenDemoRoom('demo-2026-09-28', noon)).toBe(false);
		expect(isOpenDemoRoom('demo-2026-09-30', noon)).toBe(false);
		expect(isOpenDemoRoom('demo-2019-01-01', noon)).toBe(false);
		expect(isOpenDemoRoom('demo-9999-12-31', noon)).toBe(false);
		expect(isOpenDemoRoom('other', noon)).toBe(false);

		const afterMidnight = at('2026-09-30T00:30:00Z');
		expect(isOpenDemoRoom('demo-2026-09-30', afterMidnight)).toBe(true);
		expect(isOpenDemoRoom('demo-2026-09-29', afterMidnight)).toBe(true);
		expect(isOpenDemoRoom('demo-2026-09-28', afterMidnight)).toBe(false);

		const later = at('2026-09-30T01:00:00Z');
		expect(isOpenDemoRoom('demo-2026-09-29', later)).toBe(false);
	});
});

const DOCS = 'https://docs.edytor.test';
const demoEnv = {
	ROOMS: env.ROOM,
	HISTORY: env.HISTORY,
	ALLOWED_ORIGINS: `${DOCS}, https://other-docs.test`
};

/** The shipped provider dialing the demo Worker from the page at `origin`. */
const dialDemo = (room: string, origin: string) => {
	const dials = { count: 0 };
	class DemoSocket extends SelfWebSocket {
		static override fetcher = (url: string, init: RequestInit) =>
			demo.fetch(
				new Request(url, { ...init, headers: { ...init.headers, Origin: origin } }),
				demoEnv
			);
		constructor(url: string) {
			super(url);
			dials.count++;
		}
	}
	const doc = crdt.createDoc();
	const provider = new crdt.providers.WebsocketProvider('wss://room.edytor.test/rooms', room, doc, {
		params: { guest: 'guest-0001', replica: String(doc.clientID) },
		WebSocketPolyfill: DemoSocket as unknown as typeof WebSocket,
		disableBc: true
	});
	const refused: Array<{ code: number; reason: string }> = [];
	provider.on('refused', (refusal: E.SyncRefusedError) =>
		refused.push({ code: refusal.code, reason: refusal.reason })
	);
	return { provider, dials, refused, doc };
};

describe('FW-16 · the demo refuses a closed room or another origin with a final close', () => {
	it("a page left on yesterday's room is refused (4404) and stops dialing", async () => {
		const { provider, dials, refused, doc } = dialDemo('demo-2019-01-01', DOCS);
		await vi.waitFor(() => expect(refused).toEqual([{ code: 4404, reason: 'unknown room' }]));
		// The redial would come after 100 ms+: none comes.
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect({ dials: dials.count, shouldConnect: provider.shouldConnect }).toEqual({
			dials: 1,
			shouldConnect: false
		});
		provider.destroy();
		doc.destroy();
	});

	it('a page on another origin is refused (4403) and stops dialing', async () => {
		const room = demoRoomAt(Date.now());
		const { provider, dials, refused, doc } = dialDemo(room, 'https://elsewhere.test');
		await vi.waitFor(() => expect(refused).toEqual([{ code: 4403, reason: 'origin not allowed' }]));
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(dials.count).toBe(1);
		provider.destroy();
		doc.destroy();
	});

	it('an opaque origin (`null`) or an undecodable room name is refused, never a Worker exception', async () => {
		const closeOf = async (path: string, origin: string) => {
			const response = await demo.fetch(
				new Request(`https://room.edytor.test${path}`, {
					headers: { Upgrade: 'websocket', Origin: origin }
				}),
				demoEnv
			);
			const ws = response.webSocket!;
			const closed = new Promise((resolve) =>
				ws.addEventListener('close', (event) => resolve([event.code, event.reason]))
			);
			ws.accept();
			return closed;
		};
		expect(await closeOf(`/rooms/${demoRoomAt(Date.now())}`, 'null')).toEqual([
			4403,
			'origin not allowed'
		]);
		expect(await closeOf('/rooms/demo-%E0%A4%A', DOCS)).toEqual([4404, 'unknown room']);
	});

	it("today's room from the docs origin syncs", async () => {
		const { provider, refused, doc } = dialDemo(demoRoomAt(Date.now()), DOCS);
		await vi.waitFor(() => expect(provider.synced).toBe(true));
		expect(refused).toEqual([]);
		provider.destroy();
		doc.destroy();
	});

	it('a plain request (no upgrade) still gets an HTTP status', async () => {
		const response = await demo.fetch(
			new Request('https://room.edytor.test/rooms/demo-2019-01-01', { headers: { Origin: DOCS } }),
			demoEnv
		);
		expect(response.status).toBe(404);
	});
});

describe('H11 · the demo room keeps its history in its KV binding', () => {
	it('a change opens the UTC slot; closing it writes a version the room lists and reads', async () => {
		const room = `demo-history-${Date.now()}`;
		const stub = env.DEMO.getByName(room);
		const due = await runInDurableObject(stub, async (r: DocumentRoom, state) => {
			r.transact((facade) => facade.insertText(facade.listBlockIds()[0], 0, 'hello'));
			return state.storage.sql
				.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'due.history'")
				.one().value;
		});
		const { date, slot } = slotAt(Date.now(), 'UTC');
		expect(due).toBe(slotEnd(Date.now(), 'UTC'));
		const listed = await runInDurableObject(stub, async (r: DocumentRoom) => {
			// The slot's end, now: what the alarm does at UTC noon or midnight.
			await (r.room as unknown as { closeSlot(): Promise<void> }).closeSlot();
			return r.listHistory();
		});
		const key = `history/${room}/${date}-${slot}`;
		expect(listed).toMatchObject([{ key, date, slot, blocks: 1, editors: [] }]);
		const stored = await env.HISTORY.getWithMetadata(key, 'arrayBuffer');
		expect(stored.value!.byteLength).toBe(listed[0].bytes);
		const json = await runInDurableObject(stub, (r: DocumentRoom) => r.readHistory(key));
		expect(json!.children[0].content).toEqual([{ text: 'hello' }]);
	});
});
