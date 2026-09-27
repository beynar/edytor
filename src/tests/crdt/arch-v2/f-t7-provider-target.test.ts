/**
 * arch-v2 §8.6 F-T7 — providers attached to a document are deduplicated by
 * TRANSPORT TARGET (T4, O75, P8).
 *
 * O75: "Providers attached to a document — registry keyed by transport
 * target, document lifetime". The same document attached twice to the same
 * room / database gets ONE provider, whatever factory instance carries it:
 * two views with an inline `createIndexeddbSync('notes')` are the common
 * composition (reader C10/P8 — with factory-identity dedupe they made two
 * providers that re-stored each other's hydration and double-broadcast).
 * Distinct targets still compose (IndexedDB + websocket, two rooms).
 *
 * Expectations come from the plan row ("one provider; rows grow as with one
 * view") and O75 — the row counts are compared against a one-view control,
 * never pinned to engine output.
 */
// @ts-nocheck -- tests reach raw engine/provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as idb from 'lib0-v14/indexeddb';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument } from '../../../lib/crdt/index.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';
import { generationDbName } from '../../../lib/crdt/protocols/envelope.js';

const providers = bindProviders(Y);

let counter = 0;
const uniqueName = (base) => `t4-${base}-${counter++}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = (document) =>
	new Promise((resolve) => (document.ready ? resolve() : document.onReady(resolve)));

/** A view's factory, counted: every provider it constructs bumps `counts.n`. */
const counted = (sync, counts) =>
	Object.assign((payload) => {
		counts.n += 1;
		return sync(payload);
	}, sync);

const readRows = async (name) => {
	const db = await idb.openDB(generationDbName(name), (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);
	try {
		const [updates] = idb.transact(db, ['updates'], 'readonly');
		return (await idb.getAll(updates)).length;
	} finally {
		db.close();
	}
};

/** Websocket fake that never opens (only the provider count matters here). */
class Silent {
	static OPEN = 1;
	static CLOSED = 3;
	OPEN = 1;
	readyState = 0;
	binaryType = '';
	constructor(url) {
		this.url = url;
	}
	send() {}
	close() {
		this.readyState = 3;
	}
}

const wsSync = (serverUrl, roomName = 'room') =>
	providers.createWebsocketSync({
		serverUrl,
		roomName,
		WebSocketPolyfill: Silent
	});

const value = { children: [{ type: 'paragraph', id: 'p', content: [{ text: 'notes' }] }] };

/**
 * One editing session on database `name` with `views` views, each carrying
 * its own inline `createIndexeddbSync(name)`: wait for readiness, type one
 * edit, tear down, and report the providers built and the stored row count.
 */
const session = async (name, views) => {
	const document = createDocument();
	const counts = { n: 0 };
	for (let i = 0; i < views; i++) {
		document.attachSync(counted(providers.createIndexeddbSync(name), counts), { value });
	}
	await ready(document);
	document.transact(() => document.facade.insertText('p', 0, 'x'));
	await wait(30);
	document.destroy();
	await wait(30);
	return { providers: counts.n, rows: await readRows(name) };
};

describe('F-T7 — providers keyed by transport target (T4)', () => {
	it('F-T7: two views with inline createIndexeddbSync on one document attach ONE provider', async () => {
		const name = uniqueName('notes');
		const document = createDocument();
		const counts = { n: 0 };
		document.attachSync(counted(providers.createIndexeddbSync(name), counts), { value });
		document.attachSync(counted(providers.createIndexeddbSync(name), counts), { value });
		expect(counts.n).toBe(1);
		await ready(document);
		expect(document.syncPending).toBe(false);
		expect(document.facade.blockText('p')).toBe('notes');
		document.destroy();
		await wait(20);
	});

	it('F-T7: rows grow as with one view, session after session', async () => {
		const one = uniqueName('one-view');
		const two = uniqueName('two-views');
		const control = [];
		const candidate = [];
		for (let s = 0; s < 3; s++) {
			control.push(await session(one, 1));
			candidate.push(await session(two, 2));
		}
		expect(candidate.map((r) => r.rows)).toEqual(control.map((r) => r.rows));
		expect(candidate.map((r) => r.providers)).toEqual([1, 1, 1]);
	});

	it('F-T7: inline websocket factories on one room attach ONE provider', () => {
		const document = createDocument({ value });
		const counts = { n: 0 };
		document.attachSync(counted(wsSync('ws://t4-a'), counts));
		document.attachSync(counted(wsSync('ws://t4-a'), counts));
		expect(counts.n).toBe(1);
		document.destroy();
	});

	it('F-T7: a trailing slash on the server URL names the same room', () => {
		const document = createDocument({ value });
		const counts = { n: 0 };
		document.attachSync(counted(wsSync('ws://t4-b'), counts));
		document.attachSync(counted(wsSync('ws://t4-b/'), counts));
		expect(counts.n).toBe(1);
		document.destroy();
	});

	it('F-T7: distinct targets compose (two rooms, two databases, IndexedDB + websocket)', async () => {
		const document = createDocument({ value });
		const counts = { n: 0 };
		document.attachSync(counted(wsSync('ws://t4-c', 'one'), counts));
		document.attachSync(counted(wsSync('ws://t4-c', 'two'), counts));
		document.attachSync(counted(providers.createIndexeddbSync('t4-c-one'), counts));
		document.attachSync(counted(providers.createIndexeddbSync('t4-c-two'), counts));
		document.attachSync(counted(providers.createIndexeddbSync('ws://t4-c/one'), counts));
		expect(counts.n).toBe(5);
		document.destroy();
		await wait(20);
	});

	it('F-T7: a released provider frees its target — the next attach builds a new one', async () => {
		const name = uniqueName('release');
		const document = createDocument({ value });
		const counts = { n: 0 };
		const release = document.attachSync(counted(providers.createIndexeddbSync(name), counts));
		await release();
		document.attachSync(counted(providers.createIndexeddbSync(name), counts));
		expect(counts.n).toBe(2);
		document.destroy();
		await wait(20);
	});

	it('F-T7: a factory without a target key dedupes by identity', () => {
		const document = createDocument({ value });
		let built = 0;
		let released = 0;
		const sync = () => {
			built += 1;
			return () => {
				released += 1;
			};
		};
		document.attachSync(sync);
		document.attachSync(sync);
		document.attachSync(() => {
			built += 1;
		});
		expect(built).toBe(2);
		document.destroy();
		expect(released).toBe(1);
	});

	it('F-T7: a target is per document — two documents each get their provider', async () => {
		const name = uniqueName('per-doc');
		const a = createDocument({ value });
		const b = createDocument({ value });
		const counts = { n: 0 };
		a.attachSync(counted(providers.createIndexeddbSync(name), counts));
		b.attachSync(counted(providers.createIndexeddbSync(name), counts));
		expect(counts.n).toBe(2);
		a.destroy();
		b.destroy();
		await wait(20);
	});
});
