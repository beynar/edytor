/**
 * GATE-2 attack probes — the version gate (attack item 1).
 *
 * 1a. Every write path into a doc: provider update handler, fetchUpdates
 *     hydration, websocket message. The providers gate the WIRE protocol
 *     (envelope word = 14) and the STORAGE generation (`edytor-v14:` +
 *     `custom.generation` record) — but nothing anywhere reads the document's
 *     own `meta.v` schema version before applying mutations. These tests pin
 *     the actual behavior.
 *
 * 1b. A REAL v13 update (produced by the real `yjs@13` package) is pushed
 *     onto the v14 BroadcastChannel room and the websocket path as a raw
 *     v13 sync frame (no envelope). It must never reach `applyUpdate`.
 *
 * 1c. Malformed/truncated/mis-versioned frames: fail-closed + observable,
 *     and — because lib0 delivers same-tab publishes SYNCHRONOUSLY — a bad
 *     frame must not throw back into the publisher's call stack.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import * as Y13 from 'yjs';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import { bindWebsocketProvider } from '../../../lib/crdt/providers/websocket.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { Awareness } from '../../../lib/crdt/protocols/awareness.js';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import * as bc from 'lib0-v14/broadcastchannel';
import {
	writeProtocolVersion,
	generationDbName,
	PROTOCOL_VERSION
} from '../../../lib/crdt/protocols/envelope.js';

const providers = bindIndexeddbProvider(Y);
const wsProviders = bindWebsocketProvider(Y);
const sync = bindSync(Y);
const E = bindEdytorDoc(Y);

const nextTick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, timeout = 5000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};

let counter = 0;
const uniqueName = (base) => `${base}-${counter++}`;

/** Encode a v14-enveloped message. */
const encodeV14 = (type, payloadWriter) => {
	const e = encoding.createEncoder();
	writeProtocolVersion(e);
	encoding.writeVarUint(e, type);
	payloadWriter?.(e);
	return encoding.toUint8Array(e);
};

/**
 * A REAL v13 sync message carrying a REAL v13 update — produced by the
 * yjs@13 package, framed exactly like a v13 y-websocket/y-protocols peer
 * would send it: `varuint messageType(0) | syncUpdate(2) | varuint8array`.
 */
const v13UpdateMessage = () => {
	const doc13 = new Y13.Doc();
	doc13.getMap('content').set('poison', { v13: true });
	doc13.getText('INITIALIZED'); // v13 init marker root
	const update13 = Y13.encodeStateAsUpdate(doc13);
	const e = encoding.createEncoder();
	encoding.writeVarUint(e, 0); // v13 messageSync
	encoding.writeVarUint(e, 2); // v13 sync Update
	encoding.writeVarUint8Array(e, update13);
	return { msg: encoding.toUint8Array(e), update13 };
};

describe('attack 1b: real v13 updates never reach a v14 doc', () => {
	test('v13 sync frame on the BC room: dropped, observable, doc untouched', async () => {
		const name = uniqueName('gate-v13-bc');
		const docA = new Y.Doc();
		const edA = E.create(docA);
		edA.init();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		const jsonBefore = JSON.stringify(edA.toJSON());

		const mismatches = [];
		const msgErrors = [];
		pA.on('protocol-mismatch', (m) => mismatches.push(m));
		pA.on('message-error', (e) => msgErrors.push(e));

		const { msg } = v13UpdateMessage();
		// publish() is the publisher path — it must NOT throw back at us.
		expect(() => bc.publish(generationDbName(name), msg.slice().buffer, 'v13-peer')).not.toThrow();
		await nextTick();

		expect(JSON.stringify(edA.toJSON())).toBe(jsonBefore);
		expect(docA.get('content').getAttr('poison')).toBeUndefined();
		expect(mismatches.length).toBeGreaterThan(0);
		expect(mismatches[0]).toMatchObject({ expected: PROTOCOL_VERSION, found: 0 });
		await pA.destroy();
	});

	test('v13 sync frame on the websocket path: dropped before decoding', async () => {
		const url = `ws://fake-gate2/${counter++}`;
		const docA = new Y.Doc();
		const edA = E.create(docA);
		edA.init();
		const jsonBefore = JSON.stringify(edA.toJSON());

		class FakeWS {
			static OPEN = 1;
			OPEN = 1;
			binaryType = '';
			readyState = 0;
			constructor(u) {
				this.url = u;
				setTimeout(() => {
					this.readyState = 1;
					this.onopen?.({ type: 'open' });
				});
			}
			send() {}
			close() {
				this.readyState = 3;
				this.onclose?.({});
			}
		}
		const pA = new wsProviders.WebsocketProvider(url, 'room', docA, {
			WebSocketPolyfill: FakeWS,
			disableBc: true
		});
		const mismatches = [];
		pA.on('protocol-mismatch', (m) => mismatches.push(m));
		await until(() => pA.wsconnected, 4000);

		const { msg } = v13UpdateMessage();
		expect(() => pA.ws.onmessage({ data: msg.slice().buffer })).not.toThrow();
		await nextTick();

		expect(JSON.stringify(edA.toJSON())).toBe(jsonBefore);
		expect(docA.get('content').getAttr('poison')).toBeUndefined();
		expect(mismatches.length).toBe(1);
		pA.destroy();
	});

	test('envelope is transport-only: a v14-WRAPPED v13 payload is still applied', async () => {
		// The gate authenticates the PROTOCOL, not the payload schema: a peer
		// that speaks v14 (or forges the envelope) can still feed foreign
		// update shapes to applyUpdate. v13 payloads decode under v14 — they
		// land on the legacy root keys, so the v14 projection is unaffected,
		// but the structs ARE integrated into the doc (state grows, persists).
		const name = uniqueName('gate-wrapped-v13');
		const docA = new Y.Doc();
		const edA = E.create(docA);
		edA.init();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		const jsonBefore = JSON.stringify(edA.toJSON());

		const { update13 } = v13UpdateMessage();
		const frame = encodeV14(0, (e) => sync.writeUpdate(e, update13));
		bc.publish(generationDbName(name), frame.slice().buffer, 'forged');
		await until(() => docA.get('content').getAttr('poison') !== undefined, 3000);

		// The v13 payload integrated (poison landed on the legacy root)…
		expect(docA.get('content').getAttr('poison')).toEqual({ v13: true });
		// …but the v14 projection is structurally unaffected.
		expect(JSON.stringify(edA.toJSON())).toBe(jsonBefore);
		await pA.destroy();
	});
});

describe('attack 1c: malformed envelopes fail closed + observable', () => {
	const cases = [
		['empty frame', new Uint8Array([])],
		['version word only', new Uint8Array([PROTOCOL_VERSION])],
		['bare header [14, 0]', new Uint8Array([PROTOCOL_VERSION, 0])],
		['version 13', new Uint8Array([13, 0, 0])],
		['version 15', new Uint8Array([15, 0, 0])],
		['unknown v14 message type 99', new Uint8Array([PROTOCOL_VERSION, 99])],
		['truncated awareness payload', new Uint8Array([PROTOCOL_VERSION, 1, 200, 1])],
		['truncated syncstep1 (missing sv bytes)', new Uint8Array([PROTOCOL_VERSION, 0, 50, 1, 2])],
		[
			'oversized varint version (never terminates)',
			new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])
		],
		['random garbage', new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42])],
		[
			'awareness with unparseable JSON',
			(() => {
				const e = encoding.createEncoder();
				writeProtocolVersion(e);
				encoding.writeVarUint(e, 1);
				const inner = encoding.createEncoder();
				encoding.writeVarUint(inner, 1); // one entry
				encoding.writeVarUint(inner, 1234); // clientID
				encoding.writeVarUint(inner, 0); // clock
				encoding.writeVarString(inner, '{not json');
				encoding.writeVarUint8Array(e, encoding.toUint8Array(inner));
				return encoding.toUint8Array(e);
			})()
		]
	];

	test('BC room: no frame reaches the doc or the publisher stack', async () => {
		const name = uniqueName('gate-malformed-bc');
		const docA = new Y.Doc();
		const edA = E.create(docA);
		edA.init();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		const jsonBefore = JSON.stringify(edA.toJSON());

		const mismatches = [];
		const msgErrors = [];
		pA.on('protocol-mismatch', (m) => mismatches.push(m));
		pA.on('message-error', (e) => msgErrors.push(e));

		for (const [label, frame] of cases) {
			// Synchronous same-tab delivery: a throw here means the malformed
			// frame propagated into the PUBLISHER's stack — a defect.
			expect(
				() => bc.publish(generationDbName(name), frame.slice().buffer, 'attacker'),
				label
			).not.toThrow();
			await nextTick(5);
		}
		expect(JSON.stringify(edA.toJSON())).toBe(jsonBefore);
		// Every malformed frame produces a signal — including [14, 99], a
		// valid v14 envelope carrying an unknown message type (fixed: it now
		// emits 'message-error' instead of being dropped silently).
		expect(mismatches.length + msgErrors.length).toBe(cases.length);
		// The mis-versioned ones are specifically protocol-mismatch.
		expect(mismatches.filter((m) => m.found === 13 || m.found === 15).length).toBe(2);
		await pA.destroy();
	});

	test('the BC subscriber path (the real entry) never throws to the publisher', async () => {
		const name = uniqueName('gate-malformed-sub');
		const docA = new Y.Doc();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		const events = { mismatch: 0, msgErr: 0 };
		pA.on('protocol-mismatch', () => events.mismatch++);
		pA.on('message-error', () => events.msgErr++);

		for (const [label, frame] of cases) {
			// _bcSubscriber is the exact function lib0 calls synchronously from
			// bc.publish — origin 'other-tab' so it is not short-circuited.
			expect(() => pA._bcSubscriber(frame.slice().buffer, 'other-tab'), label).not.toThrow();
		}
		// All 11 frames produce a signal; [14, 99] (valid v14 envelope,
		// unknown message type) emits 'message-error'.
		expect(events.mismatch + events.msgErr).toBe(cases.length);
		await pA.destroy();
	});

	test('a valid v14 envelope with an unknown message type produces NO event', async () => {
		const name = uniqueName('gate-unknown-type');
		const docA = new Y.Doc();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		const events = { mismatch: 0, msgErr: 0 };
		pA.on('protocol-mismatch', () => events.mismatch++);
		pA.on('message-error', () => events.msgErr++);

		// [14, 99]: valid protocol version, valid framing, message type that
		// no handler claims. readMessage returns silently — no observability
		// hook fires, so a future peer sending a newer message type (or a
		// buggy peer) is indistinguishable from silence.
		bc.publish(generationDbName(name), new Uint8Array([PROTOCOL_VERSION, 99]).buffer, 'x');
		await nextTick();

		// CONTRACT: unknown message types must surface SOME signal so peers
		// can detect protocol skew. (If forward-compat silence is the intended
		// design, that decision needs to be documented + a dedicated event.)
		expect(events.mismatch + events.msgErr).toBeGreaterThan(0); // ← fails: zero events
		await pA.destroy();
	});

	test('readMessage propagates decode errors (callers must catch)', async () => {
		const name = uniqueName('gate-malformed-direct');
		const docA = new Y.Doc();
		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		// readMessage itself does not catch — the safety lives in the
		// subscriber wrapper. A direct call on a truncated frame throws;
		// documented so future callers keep the try/catch.
		expect(() => pA.readMessage(new Uint8Array([PROTOCOL_VERSION]), false)).toThrow();
		await pA.destroy();
	});
});

describe('attack 1a: the application-schema version is never enforced', () => {
	test('providers persist + apply updates into a doc with NO meta.v', async () => {
		const name = uniqueName('gate-no-meta');
		const docA = new Y.Doc();
		// NO init — meta.v absent. Raw engine writes only.
		docA.get('blocks').setAttr('x', { rogue: true });

		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		await pA.destroy();

		// The row was persisted and re-applied — the provider never consulted
		// the document's schema version.
		const docB = new Y.Doc();
		const pB = new providers.IndexeddbPersistence(name, docB);
		await pB.whenSynced;
		// CONTRACT (plan §attack-1): provider write paths must not apply
		// updates to uninitialized documents. Today a raw-registry write is
		// persisted + re-applied into a doc with no meta.v — and the stray
		// attr is enough for isInitialized() to report true ("initialized"
		// means *any* registry content, not a version stamp).
		expect(E.isInitialized(docB)).toBe(false); // ← fails: rogue attr = "initialized"
		expect(docB.get('blocks').getAttr('x')).toBeUndefined(); // ← fails: applied anyway
		await pB.destroy();
	});

	test('an unknown meta.v does not stop provider sync or facade mutation', async () => {
		const name = uniqueName('gate-unknown-v');
		const docA = new Y.Doc();
		const edA = E.create(docA);
		edA.init();
		// Forge a future/foreign application-schema version through a
		// legitimate v14-protocol update.
		docA.transact(() => docA.get('meta').setAttr('v', 99));

		const pA = new providers.IndexeddbPersistence(name, docA);
		await pA.whenSynced;
		const docB = new Y.Doc();
		const signals = [];
		const pB = new providers.IndexeddbPersistence(name, docB);
		pB.on('protocol-mismatch', (m) => signals.push(m));
		pB.on('message-error', (e) => signals.push(e));
		await pB.whenSynced;
		await until(() => E.schemaVersion(docB) === 99, 3000);

		// CONTRACT (plan §attack-1): updates must not apply to
		// unknown-version documents — at minimum the provider must surface an
		// observable schema-mismatch signal. Nothing reads meta.v on any
		// apply path: the replica silently absorbs v99 and facade ops keep
		// mutating it.
		const edB = E.create(docB);
		const mutates = edB.insertBlock({ parent: null, index: 0 }, { id: 'x1', type: 'paragraph' });
		console.log(
			`[gate2] unknown-schema: v=${E.schemaVersion(docB)} signals=${signals.length} mutates=${mutates}`
		);
		expect(signals.length).toBeGreaterThan(0); // ← fails: no schema-compat signal exists
		await pA.destroy();
		await pB.destroy();
	});
});
