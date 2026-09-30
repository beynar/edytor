/**
 * Re-score 14 (2026-09-30), in workerd:
 * - HX-03: a listener of `doc.on('afterAllTransactions')` runs after the
 *   engine emptied its cleanups but still inside the frame's apply. A room
 *   read there used to heal (rebuild from the rows) mid-frame, and the frame
 *   handler then acknowledged an edit storage never took.
 * - HX-04: a room `transact` inside a subscriber of the room's own
 *   `transact` used to join it after `fn` returned (a write heal dropped,
 *   reported 'ok'; an unconditional writer recursed). It now throws without
 *   writing, like one inside a client frame's events (DR-rest-1).
 * - HX-12: the room's `doc` getter heals like `facade`: a write through a
 *   freshly read `doc` after a failed direct write is stored.
 * - DR-rest-2: after a direct write through `facade`, a room `transact` from
 *   `doc.on('afterAllTransactions')` is a change of its own and is stored.
 *
 * Expected values are hand-authored from the edits each test performs.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import { E, RawClient, Y, crdt, para, readFacade } from './client';

const inRoom = <T>(room: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(env.ROOM.getByName(room), (r: Room, state) => fn(r, state));

const g = globalThis as Record<string, unknown>;

/** The text of block `p` in what the room STORED (its rows, merged). */
const storedText = (r: Room) => {
	const stored = crdt.createDoc();
	Y.applyUpdate(
		stored,
		Y.mergeUpdates(
			r
				.records()
				.slice(1)
				.map((x) => x.bytes)
		)
	);
	return readFacade(stored, (f) => ({
		text: f.blockText('p'),
		seen: f.toJSON().children[0].data?.seen ?? null
	}));
};

const live = (r: Room) => ({
	text: r.facade.blockText('p'),
	seen: r.read().children[0].data?.seen ?? null
});

const FAIL_APPEND =
	"CREATE TRIGGER fail_append BEFORE INSERT ON rows WHEN NEW.kind = 'update' BEGIN SELECT RAISE(ABORT, 'injected append failure'); END";

/** A client whose `hello` the room stored and acknowledged. */
const connect = async (room: string) => {
	const document = E.createDocument({ value: { children: [para('p', 'hello')] } });
	const author = await RawClient.connect(room, document.doc, { user: 'ada' });
	await vi.waitFor(async () => expect((await inRoom(room, storedText)).text).toBe('hello'));
	const own = document.doc.clientID;
	await vi.waitFor(() => expect(author.acks.at(-1)?.get(own)).toBeGreaterThan(0));
	return { document, author, own, acked: author.acks.at(-1)!.get(own)! };
};

const refused = (fn: () => unknown) => {
	try {
		fn();
		return 'returned';
	} catch (error) {
		return String(error);
	}
};

describe("HX-03 · a room read from doc.on('afterAllTransactions') during a frame", () => {
	it.each([
		['reads `facade`', 'hx03-after-all-facade', (r: Room) => void r.facade.blockText('p')],
		['calls `read()`', 'hx03-after-all-read', (r: Room) => void r.read()],
		['reads `doc`', 'hx03-after-all-doc', (r: Room) => void r.doc],
		[
			'calls `transact`',
			'hx03-after-all-transact',
			(r: Room) => void refused(() => r.transact((f) => f.setBlock('p', { data: { seen: true } })))
		]
	])(
		'that %s while the append fails heals nothing mid-frame: the sender is faulted, not acknowledged',
		async (_, room, react) => {
			const { document, author, own, acked } = await connect(room);
			await inRoom(room, (r, state) => {
				r.doc!.on('afterAllTransactions', () => react(r));
				state.storage.sql.exec(FAIL_APPEND);
			});
			document.transact(() => document.facade.insertText('p', 5, '!'));
			await vi.waitFor(() =>
				expect(author.closed).toEqual({ code: 1011, reason: 'storage failure' })
			);
			await inRoom(room, (_r, state) => state.storage.sql.exec('DROP TRIGGER fail_append'));
			expect(author.acks.at(-1)!.get(own)).toBe(acked);
			expect(await inRoom(room, (r) => [live(r), storedText(r)])).toEqual([
				{ text: 'hello', seen: null },
				{ text: 'hello', seen: null }
			]);
			document.destroy();
		}
	);

	it('a `transact` there throws without writing on healthy storage too; the frame is stored and acknowledged', async () => {
		const room = 'hx03-after-all-transact-healthy';
		const { document, author, own, acked } = await connect(room);
		await inRoom(room, (r) => {
			g.hx03 = null;
			r.doc!.on('afterAllTransactions', () => {
				g.hx03 ??= refused(() => r.transact((f) => f.setBlock('p', { data: { seen: true } })));
			});
		});
		document.transact(() => document.facade.insertText('p', 5, '!'));
		await vi.waitFor(() => expect(author.acks.at(-1)!.get(own)).toBeGreaterThan(acked));
		const after = await inRoom(room, (r) => ({
			nested: g.hx03,
			live: live(r),
			stored: storedText(r)
		}));
		expect(after).toEqual({
			nested: expect.stringContaining('inside another transaction'),
			live: { text: 'hello!', seen: null },
			stored: { text: 'hello!', seen: null }
		});
		expect(author.closed).toBe(null);
		author.close();
		document.destroy();
	});
});

describe("HX-04 · a room transact inside a subscriber of the room's own transact", () => {
	it('throws without writing; the outer write is stored and broadcast', async () => {
		const room = 'hx04-subscriber-healthy';
		const { document, author } = await connect(room);
		const after = await inRoom(room, (r) => {
			const nested: string[] = [];
			const off = r.facade.onChange(() =>
				nested.push(refused(() => r.transact((f) => f.setBlock('p', { data: { seen: true } }))))
			);
			const result = r.transact((f) => (f.insertText('p', 5, '!'), 'ok'));
			off();
			return { result, nested, live: live(r), stored: storedText(r) };
		});
		expect(after).toEqual({
			result: 'ok',
			nested: [expect.stringContaining('inside another transaction')],
			live: { text: 'hello!', seen: null },
			stored: { text: 'hello!', seen: null }
		});
		await vi.waitFor(() => expect(document.facade.blockText('p')).toBe('hello!'));
		author.close();
		document.destroy();
	});

	it('an unconditional writer there does not recurse', async () => {
		const room = 'hx04-subscriber-unconditional';
		const { document, author } = await connect(room);
		const after = await inRoom(room, (r) => {
			let calls = 0;
			const off = r.facade.onChange(() => {
				calls++;
				r.transact((f) => f.insertText('p', 0, '>'));
			});
			const result = refused(() => r.transact((f) => f.insertText('p', 5, '!')));
			off();
			return { result, calls, live: live(r), stored: storedText(r) };
		});
		expect(after).toEqual({
			result: 'returned',
			calls: 1,
			live: { text: 'hello!', seen: null },
			stored: { text: 'hello!', seen: null }
		});
		author.close();
		document.destroy();
	});

	it('when the outer append fails, the outer throws the storage error and nothing is kept', async () => {
		const room = 'hx04-subscriber-failing';
		const { document, author } = await connect(room);
		const after = await inRoom(room, (r, state) => {
			const nested: string[] = [];
			const off = r.facade.onChange(() =>
				nested.push(refused(() => r.transact((f) => f.setBlock('p', { data: { seen: true } }))))
			);
			state.storage.sql.exec(FAIL_APPEND);
			let outer: string;
			try {
				outer = refused(() => r.transact((f) => f.insertText('p', 5, '!')));
			} finally {
				state.storage.sql.exec('DROP TRIGGER fail_append');
			}
			off();
			return { outer, nested, live: live(r), stored: storedText(r) };
		});
		expect(after).toEqual({
			outer: expect.stringContaining('injected append failure'),
			nested: [expect.stringContaining('inside another transaction')],
			live: { text: 'hello', seen: null },
			stored: { text: 'hello', seen: null }
		});
		author.close();
		document.destroy();
	});

	it("a read from doc.on('afterAllTransactions') of a failed room transact does not hide the failure", async () => {
		const room = 'hx04-after-all-failing';
		const { document, author } = await connect(room);
		const after = await inRoom(room, (r, state) => {
			r.doc!.on('afterAllTransactions', () => void r.read());
			state.storage.sql.exec(FAIL_APPEND);
			let outer: string;
			try {
				outer = refused(() => r.transact((f) => f.insertText('p', 5, '!')));
			} finally {
				state.storage.sql.exec('DROP TRIGGER fail_append');
			}
			return { outer, live: live(r), stored: storedText(r) };
		});
		expect(after).toEqual({
			outer: expect.stringContaining('injected append failure'),
			live: { text: 'hello', seen: null },
			stored: { text: 'hello', seen: null }
		});
		author.close();
		document.destroy();
	});
});

describe('HX-12 · the room `doc` getter heals like `facade`', () => {
	it('a write through a freshly read `doc` after a failed direct write is stored', async () => {
		const room = 'hx12-fresh-doc';
		const { document, author } = await connect(room);
		await inRoom(room, (r, state) => {
			state.storage.sql.exec(FAIL_APPEND);
			try {
				r.facade.insertText('p', 0, 'A');
			} finally {
				state.storage.sql.exec('DROP TRIGGER fail_append');
			}
		});
		const after = await inRoom(room, (r) => {
			const facade = crdt.doc.create(r.doc as never);
			facade.insertText('p', 0, 'B');
			facade.dispose();
			return { live: r.facade.blockText('p'), stored: storedText(r).text };
		});
		expect(after).toEqual({ live: 'Bhello', stored: 'Bhello' });
		await vi.waitFor(() => expect(document.facade.blockText('p')).toBe('Bhello'));
		author.close();
		document.destroy();
	});
});

describe('DR-rest-2 · a room transact after a direct write through `facade`', () => {
	it("from doc.on('afterAllTransactions') it runs as its own change and is stored; from onChange it throws", async () => {
		const room = 'dr-rest-2-direct-write';
		const { document, author } = await connect(room);
		const after = await inRoom(room, (r) => {
			const results: string[] = [];
			const offChange = r.facade.onChange(() =>
				results.push(
					`onChange: ${refused(() => r.transact((f) => f.setBlock('p', { data: { seen: true } })))}`
				)
			);
			let once = true;
			const listener = () => {
				if (!once) return;
				once = false;
				results.push(`after: ${refused(() => r.transact((f) => f.insertText('p', 0, '>')))}`);
			};
			r.doc!.on('afterAllTransactions', listener);
			r.facade.insertText('p', 5, '!');
			r.doc!.off('afterAllTransactions', listener);
			offChange();
			return { results, live: live(r), stored: storedText(r) };
		});
		expect(after).toEqual({
			results: [
				expect.stringContaining('onChange: Error'),
				// the room's own transact from the listener: its subscriber may not write (HX-04)
				expect.stringContaining('onChange: Error'),
				'after: returned'
			],
			live: { text: '>hello!', seen: null },
			stored: { text: '>hello!', seen: null }
		});
		author.close();
		document.destroy();
	});
});
