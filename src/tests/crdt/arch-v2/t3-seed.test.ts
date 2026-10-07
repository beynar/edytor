/**
 * arch-v2 §8.6 F-T4, F-T6, F-T11, F-T12, F-T13, F-T17 — deterministic seeds
 * and settle-or-bound readiness (T3, R13, D-3), plus the T3 carry-overs.
 *
 * R13: a document seeds content only when it is empty after every attached
 * provider settled or its bound elapsed, by applying ONE deterministic seed
 * update written by a writer id derived from a hash of the seed (caller ids
 * kept; missing ids, nonces and ranks derived), so identical seeds are
 * idempotent and different seeds union. §2.1 "Seeds": the update is applied
 * with a non-local origin — never an undo step, no attribution stamp.
 * D-3: a late identical seed never erases an edit; different templates
 * union, and shared ids resolve by last-writer-wins; no virtual first block.
 *
 * Expectations come from the plan rows, R13, §2.1 and D-3 — never from
 * engine output. Multi-replica rows run under three client-id assignments,
 * both delivery orders and duplicate delivery.
 */
// @ts-nocheck -- tests reach raw engine/provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { attachDocument, createDocument, loadDocument } from '../../../lib/crdt/index.js';
import { SCHEMA_VERSION } from '../../../lib/crdt/protocol.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';

const providers = bindProviders(Y);

/**
 * Opaque relay fake (as in the T2 rows): sockets on one URL form a room;
 * every frame is forwarded verbatim to every OTHER member, never decoded or
 * answered. A member alone in a room hears nothing.
 */
class Relay {
	static OPEN = 1;
	static CLOSED = 3;
	static rooms = new Map();

	OPEN = 1;
	binaryType = '';
	readyState = 0;
	onopen = null;
	onclose = null;
	onerror = null;
	onmessage = null;

	constructor(url) {
		this.url = url;
		setTimeout(() => {
			if (this.readyState !== 0) return;
			let room = Relay.rooms.get(url);
			if (!room) Relay.rooms.set(url, (room = new Set()));
			room.add(this);
			this.readyState = 1;
			this.onopen?.({ type: 'open' });
		});
	}

	send(data) {
		const room = Relay.rooms.get(this.url);
		if (!room) return;
		const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
		setTimeout(() => {
			for (const peer of room) {
				if (peer === this || peer.readyState !== 1) continue;
				peer.onmessage?.({ data: bytes.slice().buffer });
			}
		});
	}

	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		Relay.rooms.get(this.url)?.delete(this);
		this.onclose?.({});
	}
}

let counter = 0;
const uniqueUrl = () => `ws://relay/t3-${counter++}`;
const uniqueName = (base) => `t3-${base}-${counter++}`;
const until = async (cond, timeout = 3000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A websocket sync factory with the library's DEFAULT options (no resync, default bound). */
const wsSync = (url) =>
	providers.createWebsocketSync({
		serverUrl: url,
		roomName: 'room',
		WebSocketPolyfill: Relay
	});

/** A document on a raw doc with a pinned replica id. */
const documentOn = (clientID) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	return attachDocument(doc);
};

const json = (document) => document.facade.toJSON();
const topIds = (document) => document.facade.project().children.map((b) => b.id);
const allIds = (document) => {
	const out = [];
	const walk = (blocks) => {
		for (const b of blocks) {
			out.push(b.id);
			walk(b.children ?? []);
		}
	};
	walk(document.facade.project().children);
	return out;
};

/** Deliver each document's full state to every other one (optionally twice). */
const exchange = (documents, { reverse = false, dup = 1 } = {}) => {
	const order = reverse ? [...documents].reverse() : documents;
	const updates = order.map((d) => Y.encodeStateAsUpdate(d.doc));
	for (const [i, d] of order.entries()) {
		for (const [j, update] of updates.entries()) {
			if (i === j) continue;
			for (let k = 0; k < dup; k++) Y.applyUpdate(d.doc, update, 'remote');
		}
	}
};

/** Three client-id assignments: A < B, A > B, far apart. */
const ASSIGNMENTS = [
	[11, 22],
	[22, 11],
	[3, 2 ** 31 - 5]
];
const DELIVERIES = [
	{ reverse: false, dup: 1 },
	{ reverse: true, dup: 2 }
];

const template = (withIds) => ({
	children: [
		{ type: 'heading', ...(withIds ? { id: 'title' } : {}), content: [{ text: 'Title' }] },
		{ type: 'paragraph', ...(withIds ? { id: 'body' } : {}), content: [{ text: 'Body' }] }
	]
});

describe('F-T4 — new device: empty IndexedDB, the room already holds content (G9)', () => {
	for (const [a, b] of ASSIGNMENTS) {
		it(`value passed: local equals the room, nothing duplicated (A=${a}, B=${b})`, async () => {
			const url = uniqueUrl();
			const room = documentOn(a);
			room.sync({
				children: [{ type: 'paragraph', id: 'r1', content: [{ text: 'room content' }] }]
			});
			room.attachSync(wsSync(url));

			const device = documentOn(b);
			device.attachSync(providers.createIndexeddbSync(uniqueName('f-t4')), {
				value: { children: [{ type: 'paragraph', id: 'v1', content: [{ text: 'default seed' }] }] }
			});
			device.attachSync(wsSync(url), {
				value: { children: [{ type: 'paragraph', id: 'v1', content: [{ text: 'default seed' }] }] }
			});

			await until(() => device.ready);
			await until(() => JSON.stringify(json(device)) === JSON.stringify(json(room)));
			await wait(100);
			expect(allIds(device)).toEqual(['r1']);
			expect(allIds(room)).toEqual(['r1']);
			expect(json(device)).toEqual(json(room));
			device.destroy();
			room.destroy();
		});

		it(`no value, the room edited its default paragraph: nothing erased (A=${a}, B=${b})`, async () => {
			const url = uniqueUrl();
			const room = documentOn(a);
			room.sync();
			const [first] = topIds(room);
			room.transact(() => room.facade.insertText(first, 0, 'room content'));
			room.attachSync(wsSync(url));

			const device = documentOn(b);
			device.attachSync(providers.createIndexeddbSync(uniqueName('f-t4b')));
			device.attachSync(wsSync(url));

			await until(() => device.ready);
			await until(() => JSON.stringify(json(device)) === JSON.stringify(json(room)));
			await wait(100);
			expect(json(room)).toEqual(json(device));
			expect(topIds(room)).toHaveLength(1);
			expect(room.facade.blockText(topIds(room)[0])).toBe('room content');
			device.destroy();
			room.destroy();
		});
	}
});

describe('F-T6 — first client of a new room, default options (P6/P6b)', () => {
	it('the lone first client is ready after the bound with one paragraph; a joiner converges', async () => {
		const url = uniqueUrl();
		const first = documentOn(101);
		first.attachSync(wsSync(url));
		expect(first.ready).toBe(false);
		await until(() => first.ready);
		expect(first.readiness).toBe('local');
		expect(topIds(first)).toHaveLength(1);

		const second = documentOn(202);
		second.attachSync(wsSync(url));
		await until(() => second.ready && topIds(second).length > 0);
		expect(second.readiness).toBe('hydrated');
		expect(json(second)).toEqual(json(first));
		expect(topIds(second)).toHaveLength(1);
		second.destroy();
		first.destroy();
	});

	for (const [a, b] of ASSIGNMENTS) {
		for (const delivery of DELIVERIES) {
			it(`two concurrent default seeds produce ONE paragraph (A=${a}, B=${b}, ${JSON.stringify(delivery)})`, () => {
				const A = documentOn(a);
				const B = documentOn(b);
				A.sync();
				B.sync();
				exchange([A, B], delivery);
				expect(topIds(A)).toHaveLength(1);
				expect(json(A)).toEqual(json(B));
				A.destroy();
				B.destroy();
			});
		}
	}
});

describe('F-T11 — two clients seed the same template (F5)', () => {
	for (const withIds of [true, false]) {
		for (const [a, b] of ASSIGNMENTS) {
			for (const delivery of DELIVERIES) {
				it(`one copy (${withIds ? 'caller ids' : 'no ids'}, A=${a}, B=${b}, ${JSON.stringify(delivery)})`, () => {
					// The room reply lands after the bound: each client decided alone.
					const A = documentOn(a);
					const B = documentOn(b);
					A.sync(template(withIds));
					B.sync(template(withIds));
					exchange([A, B], delivery);
					expect(topIds(A)).toHaveLength(2);
					expect(json(A)).toEqual(json(B));
					expect(topIds(A).map((id) => A.facade.blockText(id))).toEqual(['Title', 'Body']);
					if (withIds) expect(topIds(A)).toEqual(['title', 'body']);
					A.destroy();
					B.destroy();
				});
			}
		}
	}

	it('an identical seed update is a no-op on a replica that holds it', () => {
		const E = bindEdytorDoc(Y);
		const first = new Y.Doc();
		const late = new Y.Doc();
		E.seed(first, template(false).children);
		E.seed(late, template(false).children);
		const before = Y.encodeStateVector(first);
		Y.applyUpdate(first, Y.encodeStateAsUpdate(late), 'remote');
		expect(Y.encodeStateVector(first)).toEqual(before);
		expect(Y.encodeStateAsUpdate(late)).toEqual(Y.encodeStateAsUpdate(first));
	});
});

describe('F-T12 — a late identical seed after another client edited the seed (F5)', () => {
	for (const withIds of [true, false]) {
		for (const [a, b] of ASSIGNMENTS) {
			for (const delivery of DELIVERIES) {
				it(`the edit is kept (${withIds ? 'caller ids' : 'no ids'}, A=${a}, B=${b}, ${JSON.stringify(delivery)})`, () => {
					const A = documentOn(a);
					A.sync(template(withIds));
					const [title] = topIds(A);
					A.transact(() => A.facade.insertText(title, 5, ' edited'));
					const B = documentOn(b);
					B.sync(template(withIds)); // late: B never heard A
					exchange([A, B], delivery);
					expect(json(A)).toEqual(json(B));
					expect(topIds(B)).toHaveLength(2);
					expect(B.facade.blockText(topIds(B)[0])).toBe('Title edited');
					A.destroy();
					B.destroy();
				});
			}
		}
	}
});

describe('F-T11b — the same template with a different key order (canonical seed)', () => {
	const keyed = (order) => ({
		children: [
			{
				type: 'paragraph',
				data: order
					? { align: 'left', level: 1, meta: { a: 1, b: 2 } }
					: { meta: { b: 2, a: 1 }, level: 1, align: 'left' },
				content: [
					{
						text: 'Same',
						marks: order ? { bold: true, italic: true } : { italic: true, bold: true }
					}
				]
			}
		]
	});
	for (const [a, b] of ASSIGNMENTS.slice(0, 2)) {
		for (const delivery of DELIVERIES) {
			it(`one copy, converged (A=${a}, B=${b}, ${JSON.stringify(delivery)})`, () => {
				const A = documentOn(a);
				const B = documentOn(b);
				A.sync(keyed(true));
				B.sync(keyed(false));
				exchange([A, B], delivery);
				expect(topIds(A)).toHaveLength(1);
				expect(json(A)).toEqual(json(B));
				A.destroy();
				B.destroy();
			});
		}
	}
});

describe('F-T13 — caller ids survive (FP-1)', () => {
	const demo = {
		children: [
			{ id: 'page-title', type: 'heading', content: [{ text: 'Title' }] },
			{ id: 'page-intro', type: 'paragraph', content: [{ text: 'Intro' }] },
			{
				id: 'page-toggle',
				type: 'paragraph',
				content: [{ text: 'Toggle' }],
				children: [{ id: 'page-toggle-child', type: 'paragraph', content: [{ text: 'c' }] }]
			},
			{ id: 'page-end', type: 'paragraph', content: [{ text: '' }] }
		]
	};
	const ids = ['page-title', 'page-intro', 'page-toggle', 'page-toggle-child', 'page-end'];

	it('createDocument({value}), encode/load, and onChange JSON re-mounted as value', () => {
		const created = createDocument({ value: demo });
		expect(allIds(created)).toEqual(ids);
		const loaded = loadDocument(created.encode());
		expect(allIds(loaded)).toEqual(ids);
		const remounted = createDocument({ value: loaded.facade.toJSON() });
		expect(allIds(remounted)).toEqual(ids);
		expect(json(remounted)).toEqual(json(created));
		for (const d of [created, loaded, remounted]) d.destroy();
	});

	it('ids survive a reload from IndexedDB', async () => {
		const name = uniqueName('f-t13');
		const first = attachDocument(new Y.Doc());
		first.attachSync(providers.createIndexeddbSync(name), { value: demo });
		await until(() => first.ready);
		expect(allIds(first)).toEqual(ids);
		await wait(100);
		first.destroy();

		const reload = attachDocument(new Y.Doc());
		reload.attachSync(providers.createIndexeddbSync(name), { value: demo });
		await until(() => reload.ready);
		expect(reload.readiness).toBe('hydrated');
		expect(allIds(reload)).toEqual(ids);
		reload.destroy();
	});
});

describe('F-T17 — two different templates seeded concurrently', () => {
	for (const [a, b] of ASSIGNMENTS) {
		for (const delivery of DELIVERIES) {
			it(`disjoint ids union and converge (A=${a}, B=${b}, ${JSON.stringify(delivery)})`, () => {
				const A = documentOn(a);
				const B = documentOn(b);
				A.sync({ children: [{ type: 'paragraph', id: 'a1', content: [{ text: 'one' }] }] });
				B.sync({ children: [{ type: 'paragraph', id: 'b1', content: [{ text: 'two' }] }] });
				exchange([A, B], delivery);
				expect(json(A)).toEqual(json(B));
				expect([...topIds(A)].sort()).toEqual(['a1', 'b1']);
				A.destroy();
				B.destroy();
			});

			it(`same ids, different text: one version per id, converged (A=${a}, B=${b}, ${JSON.stringify(delivery)})`, () => {
				const A = documentOn(a);
				const B = documentOn(b);
				A.sync({ children: [{ type: 'paragraph', id: 'x', content: [{ text: 'one' }] }] });
				B.sync({ children: [{ type: 'paragraph', id: 'x', content: [{ text: 'two' }] }] });
				exchange([A, B], delivery);
				expect(json(A)).toEqual(json(B));
				expect(topIds(A)).toEqual(['x']);
				expect(['one', 'two']).toContain(A.facade.blockText('x'));
				A.destroy();
				B.destroy();
			});

			it(`different templates without ids union and converge (A=${a}, B=${b}, ${JSON.stringify(delivery)})`, () => {
				const A = documentOn(a);
				const B = documentOn(b);
				A.sync({ children: [{ type: 'paragraph', content: [{ text: 'one' }] }] });
				B.sync({ children: [{ type: 'paragraph', content: [{ text: 'two' }] }] });
				exchange([A, B], delivery);
				expect(json(A)).toEqual(json(B));
				expect(topIds(A)).toHaveLength(2);
				A.destroy();
				B.destroy();
			});
		}
	}
});

describe('UW-03 — a late seed never displaces live content', () => {
	// Replica ids are random uint53 in production; a seed's writer lives in
	// a low band (below 2^26) so it loses every registry race to one. Pinned
	// ids stay above the band, as a live id is but for ~2^-27.
	const LIVE = ASSIGNMENTS.map(([a, b]) => [2 ** 26 + a, 2 ** 26 + b]);
	for (const [a, b] of LIVE) {
		for (const delivery of DELIVERIES) {
			it(`a snapshot seeded late keeps the room's later edits (A=${a}, B=${b}, ${JSON.stringify(delivery)})`, () => {
				const room = documentOn(a);
				room.sync();
				room.transact(() =>
					room.facade.insertBlock(
						{ parent: null, index: 1 },
						{ id: 'x', type: 'paragraph', content: [{ kind: 'text', text: 'hello' }] }
					)
				);
				const snapshot = json(room);
				room.transact(() => room.facade.insertText('x', 5, ' world'));
				// A client whose readiness bound elapsed before it heard the room.
				const late = documentOn(b);
				late.sync(snapshot);
				exchange([room, late], delivery);
				expect(json(late)).toEqual(json(room));
				expect(room.facade.blockText('x')).toBe('hello world');
				expect(topIds(room)).toHaveLength(2);
				room.destroy();
				late.destroy();
			});
		}
	}
});

describe('seed over seed — last-writer-wins by writer id is the contract (documents.mdx)', () => {
	// documents.mdx "A different seed" row: the larger writer id wins,
	// whichever arrived first; a losing room copy loses its edits since that
	// seed, on every replica, and undo does not bring them back.
	const one = { children: [{ type: 'paragraph', id: 'x', content: [{ text: 'one' }] }] };
	const two = { children: [{ type: 'paragraph', id: 'x', content: [{ text: 'two' }] }] };
	/** The writer id of `value`'s seed: the only other client of a replica that just seeded it. */
	const writerOf = (value) => {
		const probe = documentOn(2 ** 26 + 7);
		probe.sync(value);
		const clients = [...Y.decodeStateVector(Y.encodeStateVector(probe.doc)).keys()];
		probe.destroy();
		const writers = clients.filter((id) => id !== 2 ** 26 + 7);
		expect(writers).toHaveLength(1);
		return writers[0];
	};
	const ordered = () => (writerOf(one) < writerOf(two) ? [one, two] : [two, one]);
	const textOf = (value) => value.children[0].content[0].text;
	const LIVE = ASSIGNMENTS.map(([a, b]) => [2 ** 26 + a, 2 ** 26 + b]);
	for (const [a, b] of LIVE) {
		for (const delivery of DELIVERIES) {
			it(`a larger seed arriving late replaces the room's block and its edits (A=${a}, B=${b}, ${JSON.stringify(delivery)})`, () => {
				const [low, high] = ordered();
				const room = documentOn(a);
				room.sync(low);
				room.transact(() => room.facade.insertText('x', 3, '!'));
				const late = documentOn(b);
				late.sync(high);
				exchange([room, late], delivery);
				expect(json(late)).toEqual(json(room));
				expect(topIds(room)).toEqual(['x']);
				expect(room.facade.blockText('x')).toBe(textOf(high));
				room.history.undo();
				exchange([room, late], delivery);
				expect(room.facade.blockText('x')).toBe(textOf(high));
				expect(late.facade.blockText('x')).toBe(textOf(high));
				room.destroy();
				late.destroy();
			});

			it(`a smaller seed arriving late loses: the room keeps its block and edits (A=${a}, B=${b}, ${JSON.stringify(delivery)})`, () => {
				const [low, high] = ordered();
				const room = documentOn(a);
				room.sync(high);
				room.transact(() => room.facade.insertText('x', 3, '!'));
				const late = documentOn(b);
				late.sync(low);
				exchange([room, late], delivery);
				expect(json(late)).toEqual(json(room));
				expect(topIds(room)).toEqual(['x']);
				expect(room.facade.blockText('x')).toBe(`${textOf(high)}!`);
				room.destroy();
				late.destroy();
			});
		}
	}
});

describe('§2.1 Seeds — applied with a non-local origin', () => {
	it('the seed is never an undo step and carries no attribution stamp', () => {
		const document = createDocument({
			value: template(true),
			actor: { id: 'alice', name: 'Alice' }
		});
		expect(document.history.undoStack).toHaveLength(0);
		document.history.undo();
		expect(topIds(document)).toEqual(['title', 'body']);
		expect(document.facade.blockAttribution('title')).toBeUndefined();
		document.destroy();
	});
});

describe('T3 carry-overs', () => {
	it('(T1) a document refused at admission decides once it becomes writable again', () => {
		// Hydration delivers a same-generation state whose stamp this build
		// cannot own; admission refuses and the document stays pending.
		const source = createDocument({ value: template(true) });
		const forger = new Y.Doc();
		Y.applyUpdate(forger, source.encode());
		forger.get('meta').setAttr('v', 99);
		const forged = Y.encodeStateAsUpdate(forger);

		const document = attachDocument(new Y.Doc());
		let hydrate;
		document.attachSync(({ doc, synced }) => {
			hydrate = () => {
				Y.applyUpdate(doc, forged, 'provider');
				synced();
			};
			return () => {};
		});
		expect(() => hydrate()).toThrow();
		expect(document.readiness).toBe('pending');
		expect(document.writable).toBe(false);

		// A peer heals the stamp (a causally later supported write).
		forger.get('meta').setAttr('v', SCHEMA_VERSION);
		Y.applyUpdate(document.doc, Y.encodeStateAsUpdate(forger), 'remote');
		expect(document.writable).toBe(true);
		expect(document.readiness).toBe('hydrated');
		expect(topIds(document)).toEqual(['title', 'body']);
		document.destroy();
		source.destroy();
	});

	for (const [a, c] of [
		[5, 900],
		[900, 5]
	]) {
		it(`(T2) a fresh joiner that claims synced off a concurrent handshake seeds harmlessly (A=${a})`, async () => {
			const url = uniqueUrl();
			// A already typed into its default paragraph, offline.
			const A = documentOn(a);
			A.sync();
			A.transact(() => A.facade.insertText(topIds(A)[0], 0, 'hello'));

			// B and C are fresh; each hears the other's empty handshake,
			// claims synced on an empty document and seeds.
			const B = documentOn(c + 1);
			const C = documentOn(c + 2);
			B.attachSync(wsSync(url));
			C.attachSync(wsSync(url));
			await until(() => B.ready && C.ready);

			A.attachSync(wsSync(url));
			await until(
				() =>
					JSON.stringify(json(A)) === JSON.stringify(json(B)) &&
					JSON.stringify(json(B)) === JSON.stringify(json(C))
			);
			await wait(100);
			expect(json(A)).toEqual(json(B));
			expect(topIds(A)).toHaveLength(1);
			expect(A.facade.blockText(topIds(A)[0])).toBe('hello');
			for (const d of [A, B, C]) d.destroy();
		});
	}

	it('(T2) a client alone in a new room is resolved by the readiness bound (P6)', async () => {
		const document = documentOn(77);
		document.attachSync(wsSync(uniqueUrl()), {
			value: { children: [{ type: 'paragraph', id: 'only', content: [{ text: 'solo' }] }] }
		});
		await wait(50);
		expect(document.ready).toBe(false);
		await until(() => document.ready);
		expect(document.readiness).toBe('local');
		expect(topIds(document)).toEqual(['only']);
		document.destroy();
	});

	it('a provider that cannot report "settled" gets the default bound', async () => {
		const document = createDocument();
		document.attachSync(() => () => {}); // never synced, never failed
		expect(document.ready).toBe(false);
		await until(() => document.ready);
		expect(topIds(document)).toHaveLength(1);
		document.destroy();
	});

	it('(T2) a throwing sync factory never seeds a document it never observed', () => {
		// R13: seeding needs every ATTACHED provider settled; a factory that
		// throws never attached, so its failure is not an observation.
		const document = createDocument();
		expect(() =>
			document.attachSync(() => {
				throw new Error('mid-build');
			})
		).toThrowError('mid-build');
		expect(document.readiness).toBe('pending');
		expect(document.facade.isInitialized()).toBe(false);

		// A later provider (or explicit decision) still decides.
		document.attachSync(({ synced }) => {
			synced();
			return () => {};
		});
		expect(document.readiness).toBe('local');
		expect(topIds(document)).toHaveLength(1);
		document.destroy();
	});
});
