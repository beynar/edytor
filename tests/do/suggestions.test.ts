/**
 * Shared suggestions in the room (`room.access.suggest`, `room.access.comment`,
 * `sugg.restore`, `sugg.purge` in `docs/editor-delete-contract.md`), in
 * workerd:
 *
 * - a user who may only suggest is told so; what it suggests (under a
 *   suggestion writer that binds itself to it) is stored and relayed; what
 *   it writes that is no suggestion's (its own replica's text, a hold of
 *   another's text, a mark on another's block, a decision in another's
 *   record) is stripped, refused `suggest-only`, and the socket stays;
 * - a user who may only comment writes no document content, and its
 *   comment's anchor is written by the room;
 * - `setAccess` changes the level (a `1012` close the provider redials);
 * - a version restore drops the pending suggestions, its undo brings them
 *   back; the purge removes the records of suggestions decided before the
 *   horizon, the decision trail with them, and keeps the pending ones.
 */
import { env } from 'cloudflare:workers';
import { SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import { E, ORIGIN, RawClient, crdt, para, readFacade } from './client';
import { setNow, type CommentRoom, type TimedRoom } from './worker';

declare global {
	namespace Cloudflare {
		interface Env {
			TIMED: DurableObjectNamespace<TimedRoom>;
			COMMENTS: DurableObjectNamespace<CommentRoom>;
		}
	}
}

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-06T08:00:00Z');
const room = (name: string) =>
	name.startsWith('timed-')
		? env.TIMED.getByName(name)
		: name.startsWith('comments-')
			? env.COMMENTS.getByName(name)
			: env.ROOM.getByName(name);
const inRoom = <T>(name: string, fn: (r: Room, state: DurableObjectState) => T) =>
	runInDurableObject(room(name) as DurableObjectStub<Room>, (r: Room, state) => fn(r, state));
const roomText = (name: string, block = 'p1') =>
	inRoom(name, (r) => readFacade(r.doc!, (f) => f.blockText(block)));
const roomChanges = (name: string) =>
	inRoom(name, (r) => readFacade(r.doc!, (f) => f.suggest.changes().map((c) => [c.kind, c.text])));
const refusals = (name: string, reason: string) =>
	inRoom(name, (r) => r.refusals.filter((x) => x.reason === reason).map((x) => x.detail));

/** A writer's tab: a document seeded with `children`, dialing the room as `user`. */
const writer = async (
	name: string,
	user: string,
	children = [para('p1', 'The quick brown fox')]
) => {
	const document = E.createDocument({
		value: { children },
		actor: { id: user },
		history: { captureTimeout: 0 }
	});
	const client = await RawClient.connect(name, document.doc, {
		user,
		replica: document.doc.clientID
	});
	await vi.waitFor(() => expect(client.synced).toBe(true));
	return { document, client };
};

/** A tab of `user` at `access`: its engine doc dials, then a document attaches to what it synced. */
const join = async (name: string, user: string, access: 'suggest' | 'comment' | 'read') => {
	const doc = crdt.createDoc();
	const client = await RawClient.connect(name, doc, { user, replica: doc.clientID, access });
	await vi.waitFor(() => expect(client.synced).toBe(true));
	const document = E.attachDocument(doc, { actor: { id: user } });
	return { document, client };
};

describe('a user who may only suggest (room.access.suggest)', () => {
	it('is told so; what it suggests is stored and relayed, with its author', async () => {
		const name = 'suggest-relayed';
		const ada = await writer(name, 'ada');
		const sam = await join(name, 'sam', 'suggest');
		expect(sam.client.access).toBe('suggest');
		expect(sam.client.readOnly).toBe(false);
		const S = sam.document.facade.suggest;
		const s = S.open({ via: 'ai' });
		S.apply(s, sam.document.facade.prepare.insertText('p1', 4, 'very '));
		S.apply(s, sam.document.facade.prepare.deleteText('p1', 15, 6));
		const expected = [
			['insert', 'very '],
			['delete', 'brown ']
		];
		await vi.waitFor(async () => expect(await roomChanges(name)).toEqual(expected));
		await vi.waitFor(() =>
			expect(ada.document.facade.suggest.changes().map((c) => [c.kind, c.text])).toEqual(expected)
		);
		// Its writer is its replica: bound to it by itself, owned by it.
		const [record] = ada.document.facade.suggest.records();
		expect(record).toMatchObject({ by: 'sam', via: 'ai' });
		expect(
			await inRoom(name, (_r, state) =>
				state.storage.sql
					.exec<{ user: string }>('SELECT user FROM replicas WHERE replica = ?', record!.writer)
					.toArray()
			)
		).toEqual([{ user: 'sam' }]);
		expect(await refusals(name, 'suggest-only')).toEqual([]);
		// Its document without the suggestion is the room's as it was.
		expect(await inRoom(name, (r) => r.read().children[0]!.content)).toEqual([
			{ text: 'The quick brown fox' }
		]);
		ada.client.close();
		sam.client.close();
	});

	it('what it writes that is no suggestion is stripped, refused suggest-only; the socket stays', async () => {
		const name = 'suggest-stripped';
		const ada = await writer(name, 'ada');
		const sam = await join(name, 'sam', 'suggest');
		// Its own replica's text: a direct write.
		sam.document.facade.insertText('p1', 0, 'Direct ');
		await vi.waitFor(async () => expect(sam.client.denied).toContain('suggest-only'));
		expect(await roomText(name)).toBe('The quick brown fox');
		const [first] = await refusals(name, 'suggest-only');
		expect(first).toMatchObject({ user: 'sam', writers: [sam.document.doc.clientID] });
		// A suggestion writer of its own binding itself and writing data on Ada's block.
		const S = sam.document.facade.suggest;
		const writerId = S.writer();
		const doc = sam.document.doc as unknown as { clientID: number };
		const as = (fn: () => void) => {
			const local = doc.clientID;
			doc.clientID = writerId;
			try {
				sam.document.doc.transact(fn);
			} finally {
				doc.clientID = local;
			}
		};
		as(() => {
			(sam.document.doc as unknown as { get(n: string): { setAttr(k: string, v: unknown): void } })
				.get('attribution')
				.setAttr(`c/${writerId}`, 'sam');
			const registry = (
				sam.document.doc as unknown as {
					get(n: string): { getAttr(k: string): { setAttr(k: string, v: unknown): void } };
				}
			).get('blocks');
			registry.getAttr('p1').setAttr('d/color', 'red');
		});
		await vi.waitFor(async () => expect((await refusals(name, 'suggest-only')).length).toBe(2));
		expect(await inRoom(name, (r) => r.read().children.map((b) => b.id))).toEqual(['p1']);
		// The socket stays: a suggestion still goes through (after what the room holds of the
		// text: sam's own copy keeps its stripped write, which the room never receives).
		const s = S.open();
		const end = sam.document.facade.displayLength('p1');
		S.apply(s, sam.document.facade.prepare.insertText('p1', end, '!'));
		await vi.waitFor(async () => expect(await roomChanges(name)).toEqual([['insert', '!']]));
		expect(sam.client.closed).toBe(null);
		ada.client.close();
		sam.client.close();
	});

	it('cannot decide: a settled list it writes in another author’s suggestion is stripped', async () => {
		const name = 'suggest-decide';
		const ada = await writer(name, 'ada');
		const S = ada.document.facade.suggest;
		const s = S.open();
		S.apply(s, ada.document.facade.prepare.insertText('p1', 0, 'Big '));
		const sam = await join(name, 'sam', 'suggest');
		await vi.waitFor(() => expect(sam.document.facade.suggest.changes()).toHaveLength(1));
		// Sam's writer accepts Ada's insertion: a settled list, in Ada's record.
		const T = sam.document.facade.suggest;
		const w = T.writer();
		const local = sam.document.doc.clientID;
		(sam.document.doc as { clientID: number }).clientID = w;
		try {
			T.run(T.decide(T.changes(), true));
		} finally {
			(sam.document.doc as { clientID: number }).clientID = local;
		}
		await vi.waitFor(async () => expect((await refusals(name, 'suggest-only')).length).toBe(1));
		expect(await roomChanges(name)).toEqual([['insert', 'Big ']]);
		ada.client.close();
		sam.client.close();
	});
});

describe('a user who may only comment (room.access.comment)', () => {
	it('writes no document content; its comment’s anchor is written by the room', async () => {
		const name = 'comments-only';
		const ada = await writer(name, 'ada');
		const cy = await join(name, 'cy', 'comment');
		expect(cy.client.readOnly).toBe(true);
		expect(cy.client.access).toBe('comment');
		// Its anchors on "quick", read before its own copy changes.
		const f = cy.document.facade;
		const anchors = [{ start: f.anchorAt('p1', 4, 'right'), end: f.anchorAt('p1', 9, 'left') }];
		// A document write is refused (read-only), the socket stays.
		cy.document.facade.insertText('p1', 0, 'X');
		await vi.waitFor(() => expect(cy.client.denied).toContain('read-only'));
		expect(await roomText(name)).toBe('The quick brown fox');
		// A comment on "quick", with its anchors, which the room marks.
		const response = await SELF.fetch(`${ORIGIN}/comments/${name}?user=cy&access=comment`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ op: 'add', thread: 't1', body: 'Why quick?', quote: 'quick', anchors })
		});
		expect(response.status, await response.clone().text()).toBe(200);
		await vi.waitFor(async () =>
			expect(await inRoom(name, (r) => readFacade(r.doc!, (facade) => facade.runs('p1')))).toEqual([
				{ kind: 'text', text: 'The ' },
				{ kind: 'text', text: 'quick', marks: { 'comment:t1': { id: 't1' } } },
				{ kind: 'text', text: ' brown fox' }
			])
		);
		// A reader still may not comment.
		const refused = await SELF.fetch(`${ORIGIN}/comments/${name}?user=zed&access=read`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ op: 'add', thread: 't2', body: 'x' })
		});
		expect(refused.status).toBe(403);
		ada.client.close();
		cy.client.close();
	});
});

describe('setAccess between the levels', () => {
	it('a writer set to suggest is closed 1012 and redials; a suggest-only user set to write too', async () => {
		const name = 'suggest-set-access';
		const ada = await writer(name, 'ada');
		expect(await inRoom(name, (r) => r.setAccess('ada', 'suggest'))).toEqual({ sockets: 1 });
		await vi.waitFor(() =>
			expect(ada.client.closed).toEqual({ code: 1012, reason: 'access changed' })
		);
		const sam = await join(name, 'sam', 'suggest');
		expect(await inRoom(name, (r) => r.setAccess('sam', 'write'))).toEqual({ sockets: 1 });
		await vi.waitFor(() => expect(sam.client.closed?.code).toBe(1012));
	});
});

const clockTo = (name: string, at: number) =>
	inRoom(name, (_r, state) => setNow(state.storage.sql, at));
const advance = async (name: string, at: number) => {
	await clockTo(name, at);
	await runDurableObjectAlarm(room(name));
	await inRoom(name, (r) => (r as unknown as TimedRoom).historyWritten());
};

describe('a version restore and the purge (sugg.restore, sugg.purge)', () => {
	it('a restore drops the pending suggestions; its undo brings them back', async () => {
		const name = 'timed-utc-suggest-restore';
		await clockTo(name, T0);
		const ada = await writer(name, 'ada');
		await clockTo(name, Date.parse('2026-10-06T12:00:00Z'));
		await advance(name, Date.parse('2026-10-06T12:00:00Z'));
		const key = `history/${name}/2026-10-06-am`;
		const S = ada.document.facade.suggest;
		const s = S.open();
		S.apply(s, ada.document.facade.prepare.insertText('p1', 4, 'very '));
		S.apply(s, ada.document.facade.prepare.deleteText('p1', 15, 6));
		await vi.waitFor(async () => expect(await roomChanges(name)).toHaveLength(2));
		await clockTo(name, Date.parse('2026-10-06T13:00:00Z'));
		const result = await inRoom(name, (r) => r.restoreHistory(key, { user: 'ada' }));
		expect(result).toMatchObject({ status: 'applied' });
		expect(await roomChanges(name)).toEqual([]);
		expect(await roomText(name)).toBe('The quick brown fox');
		await vi.waitFor(() => expect(S.changes()).toEqual([]));
		expect(await inRoom(name, (r) => r.undoRestore())).toEqual({ status: 'applied' });
		expect(await roomChanges(name)).toEqual([
			['insert', 'very '],
			['delete', 'brown ']
		]);
		ada.client.close();
	});

	it('the purge removes a suggestion decided before the horizon, its trail with it; a pending one stays', async () => {
		const name = 'timed-nohistory-suggest-purge';
		await clockTo(name, T0);
		const ada = await writer(name, 'ada');
		const S = ada.document.facade.suggest;
		await clockTo(name, T0 + 3600_000);
		const decided = S.open();
		S.apply(decided, ada.document.facade.prepare.insertText('p1', 0, 'Oh, '));
		S.run(S.decide(S.changes(), true));
		const pending = S.open({ writer: S.records()[0]!.writer });
		S.apply(pending, ada.document.facade.prepare.insertText('p1', 23, '!'));
		await vi.waitFor(async () =>
			expect(await inRoom(name, (r) => readFacade(r.doc!, (f) => f.suggest.records().length))).toBe(
				2
			)
		);
		await advance(name, T0 + DAY);
		await advance(name, T0 + 31 * DAY);
		expect(await inRoom(name, (r) => r.metrics().purge)).toMatchObject({ runs: 1, suggestions: 1 });
		await vi.waitFor(() => expect(S.records().map((r) => r.id)).toEqual([pending]));
		expect(await roomChanges(name)).toEqual([['insert', '!']]);
		// The accepted text reads as ordinary text.
		expect(await roomText(name)).toBe('Oh, The quick brown fox!');
		expect(await inRoom(name, (r) => r.read().children[0]!.content)).toEqual([
			{ text: 'Oh, The quick brown fox' }
		]);
		ada.client.close();
	});
});
