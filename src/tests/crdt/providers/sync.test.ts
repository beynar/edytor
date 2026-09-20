/**
 * SY01 — provider-level sync evidence for the v14 provider stack.
 *
 * - Independent offline peers converge after connecting.
 * - Reordered + duplicated message delivery converges (CRDT dedupes).
 * - State-vector synchronization (SyncStep1 → SyncStep2) transfers only the
 *   missing state.
 * - Runs the ACTUAL provider stack: two `IndexeddbPersistence` providers,
 *   two docs, real BroadcastChannel (lib0-v14, node), fake-indexeddb.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import { Awareness } from '../../../lib/crdt/protocols/awareness.js';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import {
	writeProtocolVersion,
	generationDbName,
	PROTOCOL_VERSION
} from '../../../lib/crdt/protocols/envelope.js';

const providers = bindIndexeddbProvider(Y);
const sync = bindSync(Y);

const nextTick = () => new Promise((r) => setTimeout(r, 20));
const until = async (cond, timeout = 5000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};

let dbCounter = 0;
const uniqueName = (base) => `${base}-${dbCounter++}`;

const encodeV14 = (type, payloadWriter) => {
	const e = encoding.createEncoder();
	writeProtocolVersion(e);
	encoding.writeVarUint(e, type);
	payloadWriter?.(e);
	return encoding.toUint8Array(e);
};

describe('SY01: sync protocol over real providers', () => {
	test('offline peers converge after BroadcastChannel sync', async () => {
		const name = uniqueName('sy01-offline');
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const awA = new Awareness(docA);
		const awB = new Awareness(docB);

		// A edits while B is offline (no provider yet)
		docA.get('content').setAttr('x', 'a-1');
		docA.transact(() => docA.get('content').insert(0, ['hello']));

		const pA = new providers.IndexeddbPersistence(name, docA, { awareness: awA });
		await pA.whenSynced;

		// B joins later — its provider publishes SyncStep1; A replies
		// SyncStep2 with the missing state.
		const pB = new providers.IndexeddbPersistence(name, docB, { awareness: awB });
		await pB.whenSynced;
		await until(() => docB.get('content').getAttr('x') === 'a-1', 4000);

		expect(docB.get('content').getAttr('x')).toBe('a-1');
		expect(docB.get('content').toArray()).toEqual(['hello']);

		// B edits back — A converges
		docB.get('content').setAttr('y', 'b-2');
		await until(() => docA.get('content').getAttr('y') === 'b-2', 4000);
		expect(docA.get('content').getAttr('y')).toBe('b-2');

		await pA.destroy();
		await pB.destroy();
	});

	test('reordered + duplicated update delivery converges', () => {
		// Protocol level: deliver SyncStep2/Update messages out of order and
		// duplicated — the CRDT dedupes; only the union state survives.
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		docA.get('content').setAttr('k1', 1);
		const u1 = Y.encodeStateAsUpdate(docA);
		docA.get('content').setAttr('k2', 2);
		const u2 = Y.encodeStateAsUpdate(docA);
		docA.get('content').setAttr('k3', 3);
		const u3 = Y.encodeStateAsUpdate(docA);

		const apply = (doc, update) => {
			const e = encoding.createEncoder();
			sync.writeUpdate(e, update);
			const msg = encoding.toUint8Array(e);
			const dec = decoding.createDecoder(msg);
			const enc = encoding.createEncoder();
			expect(sync.readSyncMessage(dec, enc, doc, 'test')).toBe(sync.messageYjsUpdate);
		};

		// deliver u3, u1, u2 — then duplicates
		apply(docB, u3);
		apply(docB, u1);
		apply(docB, u2);
		apply(docB, u1);
		apply(docB, u3);
		apply(docB, u2);

		expect(docB.get('content').getAttr('k1')).toBe(1);
		expect(docB.get('content').getAttr('k2')).toBe(2);
		expect(docB.get('content').getAttr('k3')).toBe(3);
		expect(Y.encodeStateVector(docB)).toEqual(Y.encodeStateVector(docA));
	});

	test('state-vector sync transfers only missing state', () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		docA.get('content').setAttr('a', 1);
		// B learns a subset first
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		docA.get('content').setAttr('b', 2);

		// B sends SyncStep1 (its state vector) → A answers SyncStep2
		const e1 = encoding.createEncoder();
		sync.writeSyncStep1(e1, docB);
		const dec1 = decoding.createDecoder(encoding.toUint8Array(e1));
		const enc1 = encoding.createEncoder();
		expect(sync.readSyncMessage(dec1, enc1, docA, 'test')).toBe(sync.messageYjsSyncStep1);
		// A's reply is a SyncStep2 with just the diff
		const replyDec = decoding.createDecoder(encoding.toUint8Array(enc1));
		expect(sync.readSyncMessage(replyDec, encoding.createEncoder(), docB, 'test')).toBe(
			sync.messageYjsSyncStep2
		);
		expect(docB.get('content').getAttr('b')).toBe(2);
		expect(Y.encodeStateVector(docB)).toEqual(Y.encodeStateVector(docA));
	});

	test('provider drops unversioned (v13-shaped) room messages', async () => {
		const name = uniqueName('sy01-gate');
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const pA = new providers.IndexeddbPersistence(name, docA);
		const pB = new providers.IndexeddbPersistence(name, docB);
		await pA.whenSynced;
		await pB.whenSynced;

		const mismatches = [];
		pB.on('protocol-mismatch', (m) => mismatches.push(m));

		// Forge a v13-format message: NO version word — first varuint is the
		// message type 0 (sync) followed by a SyncStep1 for a foreign doc.
		const foreign = new Y.Doc();
		foreign.get('content').setAttr('poison', true);
		const e = encoding.createEncoder();
		encoding.writeVarUint(e, 0); // v13 messageSync
		sync.writeSyncStep1(e, foreign);
		const v13Msg = encoding.toUint8Array(e);

		// publish into the shared room
		const { publish } = await import('lib0-v14/broadcastchannel');
		publish(generationDbName(name), v13Msg.buffer.slice(0), 'v13-peer');
		await nextTick();

		// B's doc must not have synced with the foreign doc — gate dropped it.
		expect(docB.get('content').getAttr('poison')).toBeUndefined();
		expect(mismatches.length).toBeGreaterThan(0);
		expect(mismatches[0].expected).toBe(PROTOCOL_VERSION);

		await pA.destroy();
		await pB.destroy();
	});

	test('awareness states propagate between providers', async () => {
		const name = uniqueName('sy01-aw');
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const awA = new Awareness(docA);
		const awB = new Awareness(docB);
		const pA = new providers.IndexeddbPersistence(name, docA, { awareness: awA });
		const pB = new providers.IndexeddbPersistence(name, docB, { awareness: awB });
		await pA.whenSynced;
		await pB.whenSynced;

		awA.setLocalStateField('user', { name: 'ada' });
		await until(() => awB.getStates().get(docA.clientID)?.user?.name === 'ada', 4000);
		expect(awB.getStates().get(docA.clientID)?.user?.name).toBe('ada');

		await pA.destroy();
		await until(() => awB.getStates().get(docA.clientID) === undefined, 4000);
		await pB.destroy();
	});
});
