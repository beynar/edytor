/**
 * Independent review 2026-09-29 — transport boundaries. The first two rows
 * are the reviewer's reproductions (kept verbatim as regression rows); the
 * rest are the variants added with the fixes:
 *
 * - admission of pending structs (`protocols/sync.ts` `applyRemote`): a
 *   forged stamp that pends until its dependency arrives is discarded,
 *   whatever the delivery order or the number of pieces, and a pending
 *   delete of a stamp the dependency brings is judged the same way; an
 *   honest out-of-order write still integrates;
 * - save tracking of deletions (`providers/websocket.ts`): a local update
 *   is saved when the room's acknowledgement covers its structs (state
 *   vector) AND its deletes (the acknowledged delete set).
 */
import { describe, expect, it } from 'vitest';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import { Y } from '../../../lib/crdt/engine.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import { bindWebsocketProvider } from '../../../lib/crdt/providers/websocket.js';
import {
	createDocument,
	schemaVersion,
	SCHEMA_VERSION,
	type EngineDoc
} from '../../../lib/crdt/index.js';

const paragraph = { children: [{ id: 'p', type: 'paragraph', content: [{ text: 'hello' }] }] };

/** A writer seeded like the receiver's peers, and the updates `write` produces. */
const capture = (write: (doc: ReturnType<typeof createDocument>['doc']) => void) => {
	const writer = createDocument({ value: paragraph });
	const initial = writer.encode();
	const updates: Uint8Array[] = [];
	writer.doc.on('update', (u: Uint8Array) => updates.push(u));
	write(writer.doc);
	writer.destroy();
	return { initial, updates };
};

const pendingOf = (doc: unknown) => {
	const store = (doc as EngineDoc).store!;
	return { structs: store.pendingStructs !== null, ds: store.pendingDs !== null };
};

describe('independent review: transport boundaries', () => {
	it('a schema overwrite delivered before its origin never mutates the admitted schema', () => {
		const writer = createDocument({
			value: { children: [{ id: 'p', type: 'paragraph', content: [{ text: 'hello' }] }] }
		});
		const initial = writer.encode();
		let forged = new Uint8Array();
		writer.doc.once('update', (u: Uint8Array) => {
			forged = u;
		});
		writer.doc.get('meta').setAttr('v', 99);
		const receiver = new Y.Doc();
		const sync = bindSync(Y);
		const pending = sync.applyRemote(receiver, forged, 'review');
		const dependency = sync.applyRemote(receiver, initial, 'review');
		const observed = { pending, dependency, version: schemaVersion(receiver) };
		writer.destroy();
		receiver.destroy();
		expect(observed.version, JSON.stringify(observed)).toBe(SCHEMA_VERSION);
	});

	it('undo of an acknowledged insertion remains unsaved until a new acknowledgement', () => {
		const document = createDocument({
			value: { children: [{ id: 'p', type: 'paragraph', content: [{ text: 'hello' }] }] },
			history: { captureTimeout: 0 }
		});
		const Provider = bindWebsocketProvider(Y).WebsocketProvider;
		const provider = new Provider('ws://review.invalid', 'delete-only', document.doc, {
			connect: false,
			disableBc: true,
			awareness: document.awareness
		});
		document.transact(() => document.facade.insertText('p', 5, '!'));
		const acknowledged = Y.encodeStateVector(document.doc);
		provider._acknowledge(acknowledged);
		expect(provider.saved).toBe(true);
		document.history.undo();
		const observed = {
			text: document.facade.blockText('p'),
			vectorUnchanged:
				Array.from(Y.encodeStateVector(document.doc)).join() === Array.from(acknowledged).join(),
			saved: provider.saved,
			unsaved: provider.unsaved
		};
		provider.destroy();
		document.destroy();
		expect(observed.text).toBe('hello');
		expect(observed.saved, JSON.stringify(observed)).toBe(false);
	});

	it('a forged stamp chain delivered in pieces before its origin is discarded when the origin arrives', () => {
		const { initial, updates } = capture((doc) => {
			doc.transact(() => doc.get('meta').setAttr('v', SCHEMA_VERSION)); // a same-value rewrite
			doc.transact(() => doc.get('meta').setAttr('v', 99)); // forged, over it
			doc.transact(() => doc.get('meta').setAttr('schema', 'other')); // forged manifest
		});
		const receiver = new Y.Doc();
		const sync = bindSync(Y);
		const results = [...updates].reverse().map((u) => sync.applyRemote(receiver, u, 'review'));
		const pendingBefore = pendingOf(receiver);
		const dependency = sync.applyRemote(receiver, initial, 'review');
		const observed = {
			results,
			pendingBefore,
			dependency,
			version: schemaVersion(receiver),
			pendingAfter: pendingOf(receiver)
		};
		receiver.destroy();
		expect(observed, JSON.stringify(observed)).toMatchObject({
			results: [{ applied: true }, { applied: true }, { applied: true }],
			pendingBefore: { structs: true },
			dependency: { applied: true, problem: null, discarded: { kind: expect.any(String) } },
			version: SCHEMA_VERSION,
			pendingAfter: { structs: false, ds: false }
		});
	});

	it('a pending delete of the stamp its dependency brings is discarded (the stamp survives)', () => {
		const { initial, updates } = capture((doc) => doc.get('meta').deleteAttr('v'));
		const receiver = new Y.Doc();
		const sync = bindSync(Y);
		const pending = sync.applyRemote(receiver, updates[0], 'review');
		const pendingBefore = pendingOf(receiver);
		const dependency = sync.applyRemote(receiver, initial, 'review');
		const observed = { pending, pendingBefore, dependency, version: schemaVersion(receiver) };
		receiver.destroy();
		expect(observed, JSON.stringify(observed)).toMatchObject({
			pending: { applied: true, problem: null },
			pendingBefore: { ds: true },
			dependency: { applied: true, problem: null, discarded: { kind: 'unversioned' } },
			version: SCHEMA_VERSION
		});
	});

	it('an honest write delivered before its origin still integrates when the origin arrives', () => {
		const writer = createDocument({ value: paragraph });
		const initial = writer.encode();
		const updates: Uint8Array[] = [];
		writer.doc.on('update', (u: Uint8Array) => updates.push(u));
		writer.transact(() => writer.facade.insertText('p', 5, ' world'));
		writer.transact(() => writer.facade.deleteText('p', 0, 1));
		const doc = new Y.Doc();
		const sync = bindSync(Y);
		const early = [...updates].reverse().map((u) => sync.applyRemote(doc, u, 'review'));
		const dependency = sync.applyRemote(doc, initial, 'review');
		const observed = {
			early,
			dependency,
			version: schemaVersion(doc),
			pending: pendingOf(doc),
			converged:
				Array.from(Y.encodeStateVector(doc)).join() ===
				Array.from(Y.encodeStateVector(writer.doc)).join()
		};
		writer.destroy();
		doc.destroy();
		expect(observed, JSON.stringify(observed)).toEqual({
			early: [
				{ applied: true, problem: null },
				{ applied: true, problem: null }
			],
			dependency: { applied: true, problem: null },
			version: SCHEMA_VERSION,
			pending: { structs: false, ds: false },
			converged: true
		});
	});

	describe('save tracking covers deletes', () => {
		/** A provider (never connected) on `value`, a stand-in room, and the acknowledgement it would send. */
		const setup = (value: object) => {
			const document = createDocument({ value, history: { captureTimeout: 0 } });
			const Provider = bindWebsocketProvider(Y).WebsocketProvider;
			const provider = new Provider('ws://review.invalid', 'deletes', document.doc, {
				connect: false,
				disableBc: true,
				awareness: document.awareness
			});
			const sync = bindSync(Y);
			const room = new Y.Doc();
			const updates: Uint8Array[] = [];
			document.doc.on('update', (u: Uint8Array) => updates.push(u));
			/** The room stores `update` (when given) and answers it with `writeSaved`. */
			const deliver = (update?: Uint8Array) => {
				if (update) expect(sync.applyRemote(room, update, 'client').applied).toBe(true);
				const body = encoding.encode((e) =>
					sync.writeSaved(e, room, update && Y.decodeUpdate(update).ds)
				);
				const { stateVector, deletes } = sync.readSaved(decoding.createDecoder(body));
				provider._acknowledge(stateVector, deletes);
			};
			deliver(document.encode());
			const vector = () => Array.from(Y.encodeStateVector(document.doc)).join();
			const done = () => {
				provider.destroy();
				document.destroy();
				room.destroy();
			};
			return { document, provider, updates, deliver, vector, done };
		};

		it('undoing an acknowledged block deletion (no clock advances) is unsaved until its deletes are acknowledged', () => {
			const { document, provider, updates, deliver, vector, done } = setup({
				children: [
					{ id: 'p', type: 'paragraph', content: [{ text: 'hello' }] },
					{ id: 'q', type: 'paragraph', content: [{ text: 'bye' }] }
				]
			});
			expect(provider.saved).toBe(true);
			document.transact(() => document.facade.deleteBlock('q'));
			deliver(updates.at(-1));
			expect(provider.saved).toBe(true);
			const before = vector();
			document.history.undo();
			const undo = updates.at(-1)!;
			const observed = {
				restored: document.facade.isVisibleBlock('q'),
				vectorUnchanged: vector() === before,
				saved: provider.saved,
				unsaved: provider.unsaved
			};
			// An acknowledgement of another message (a Step1: the state vector alone) covers nothing new.
			deliver();
			const afterStateVectorAck = provider.saved;
			deliver(undo);
			const afterDeletesAck = { saved: provider.saved, unsaved: provider.unsaved };
			done();
			expect(
				{ observed, afterStateVectorAck, afterDeletesAck },
				JSON.stringify({ observed, afterStateVectorAck, afterDeletesAck })
			).toEqual({
				observed: { restored: true, vectorUnchanged: true, saved: false, unsaved: 1 },
				afterStateVectorAck: false,
				afterDeletesAck: { saved: true, unsaved: 0 }
			});
		});

		it('a mixed insert-and-delete undo needs both its clock and its deletes acknowledged', () => {
			const { document, provider, updates, deliver, done } = setup(paragraph);
			document.transact(() => {
				document.facade.deleteText('p', 0, 1);
				document.facade.insertText('p', 0, 'J');
			});
			deliver(updates.at(-1));
			expect(provider.saved).toBe(true);
			document.history.undo();
			const undo = updates.at(-1)!;
			const text = document.facade.blockText('p');
			const deletes = !Y.decodeUpdate(undo).ds.isEmpty();
			// The room's state vector covers the undo's structs, but the ack names none of its deletes.
			const roomLike = new Y.Doc();
			Y.applyUpdate(roomLike, Y.encodeStateAsUpdate(document.doc));
			provider._acknowledge(Y.encodeStateVector(roomLike));
			roomLike.destroy();
			const clockOnly = provider.saved;
			deliver(undo);
			const both = provider.saved;
			done();
			expect({ text, deletes, clockOnly, both }).toEqual({
				text: 'hello',
				deletes: true,
				clockOnly: false,
				both: true
			});
		});

		it('deletes the room holds pending (their items missing) are never acknowledged', () => {
			const { document, provider, updates, deliver, done } = setup(paragraph);
			document.transact(() => document.facade.insertText('p', 5, '!'));
			const insert = updates.at(-1)!;
			document.transact(() => document.facade.deleteText('p', 5, 1));
			const remove = updates.at(-1)!;
			// The deletion reaches the room before the insertion it deletes.
			deliver(remove);
			const beforeInsert = provider.saved;
			deliver(insert);
			const afterInsert = { saved: provider.saved, unsaved: provider.unsaved };
			// A reconnect's Step2 (the full state) acknowledges everything the room now holds.
			deliver(Y.encodeStateAsUpdate(document.doc));
			const afterStep2 = provider.saved;
			done();
			expect({ beforeInsert, afterInsert, afterStep2 }).toEqual({
				beforeInsert: false,
				afterInsert: { saved: false, unsaved: 1 },
				afterStep2: true
			});
		});
	});
});
