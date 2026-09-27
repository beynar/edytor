/**
 * Gate-F1 probe, rewritten at arch-v2 T1 — the inbound refusal
 * (`applyRemote`) that replaced per-update staging (D-2, L55).
 *
 * Frames already proved their generation (engine + wire + schema), so
 * nothing is staged: an inbound update is scanned once — O(update) — for a
 * write that forges the `meta` stamp, and applied directly otherwise.
 *
 * It verifies the correctness edges the staging suite pinned:
 *   - a refused update leaves the live store byte-identical;
 *   - an unsupported version, a foreign manifest name, a parentless
 *     overwrite, and a deleted stamp are refused;
 *   - a brand-new peer's SyncStep2 (full state, our stamp) applies;
 *   - a corrupt payload is reported and mutates nothing;
 *   - a forged stamp that slips in through pending resolution leaves the
 *     document read-only (the `writable` guard, O18).
 *
 * The keystroke-burst timing is printed, not asserted.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import {
	bindEdytorDoc,
	bindSync,
	checkSchema,
	createDocument,
	SchemaMismatchError,
	SCHEMA_VERSION
} from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);
const S = bindSync(Y);

const BLOCKS = 1000;
const BURST = 100;

/** Build a live doc with BLOCKS paragraphs of 40 chars each. */
const buildLive = () => {
	const doc = new Y.Doc({ guid: 'staging-bench' });
	E.init(doc, {
		content: Array.from({ length: BLOCKS }, (_, i) => ({
			id: `b${i}`,
			type: 'paragraph',
			content: [{ kind: 'text', text: `block-${i}-abcdefghijklmnopqrstuvwxyz0123` }]
		}))
	});
	return doc;
};

/** A remote peer whose update stream we replay against the live doc. */
const buildRemote = (seedUpdate: Uint8Array) => {
	const remote = new Y.Doc({ guid: 'staging-bench' });
	Y.applyUpdate(remote, seedUpdate);
	return remote;
};

describe('gateF1 WU3b — inbound refusal (applyRemote)', () => {
	it('a 100-keystroke burst on 1,000 blocks applies directly (timing printed)', () => {
		const live = buildLive();
		const remote = buildRemote(Y.encodeStateAsUpdate(live));
		const red = E.create(remote);
		const updates: Uint8Array[] = [];
		remote.on('update', (u: Uint8Array) => updates.push(u));
		for (let i = 0; i < BURST; i++) {
			remote.transact(() => red.insertText(`b${i % BLOCKS}`, 5, 'x'));
		}
		expect(updates.length).toBe(BURST);

		const t0 = performance.now();
		for (const u of updates) expect(S.applyRemote(live, u, 'bench').applied).toBe(true);
		const remoteMs = performance.now() - t0;
		const live2 = buildLive();
		const t1 = performance.now();
		for (const u of updates) Y.applyUpdate(live2, u, 'bench');
		const directMs = performance.now() - t1;
		console.log(
			`[WU3b] applyRemote: ${(remoteMs / BURST).toFixed(3)}ms/update; ` +
				`direct apply: ${(directMs / BURST).toFixed(3)}ms/update`
		);
		expect(E.create(live).blockText('b0')).toContain('x');
	});

	it('a refused update leaves the live doc byte-identical', () => {
		const live = buildLive();
		const before = Y.encodeStateAsUpdate(live);
		const poison = new Y.Doc({ guid: 'other' });
		poison.clientID = Number.MAX_SAFE_INTEGER;
		poison.get('meta').setAttr('v', 99);
		const res = S.applyRemote(live, Y.encodeStateAsUpdate(poison), 'bench');
		expect(res.applied).toBe(false);
		expect(res.problem).toMatchObject({ kind: 'unsupported', version: 99 });
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
	});

	it('a valid-version update carrying a foreign meta.schema is refused', () => {
		const live = buildLive();
		const before = Y.encodeStateAsUpdate(live);
		const foreign = new Y.Doc({ guid: 'staging-bench' });
		Y.applyUpdate(foreign, Y.encodeStateAsUpdate(live));
		foreign.get('meta').setAttr('schema', 'not-edytor');
		const diff = Y.encodeStateAsUpdate(foreign, Y.encodeStateVector(live));
		const res = S.applyRemote(live, diff, 'bench');
		expect(res.applied).toBe(false);
		expect(res.problem?.kind).toBe('foreign');
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
		expect(live.get('meta').getAttr('schema')).toBe('edytor-doc');
	});

	it('a brand-new peer SyncStep2 (full state, our stamp) applies', () => {
		const live = new Y.Doc({ guid: 'staging-bench' });
		const full = Y.encodeStateAsUpdate(buildLive());
		const res = S.applyRemote(live, full, 'bench');
		expect(res).toEqual({ applied: true, problem: null });
		expect(E.create(live).childrenIds(null).length).toBe(BLOCKS);
	});

	it('a meta.v OVERWRITE (parentless wire item) is caught through its origin chain', () => {
		const live = buildLive();
		const before = Y.encodeStateAsUpdate(live);
		const peer = new Y.Doc({ guid: 'staging-bench' });
		peer.clientID = Number.MAX_SAFE_INTEGER;
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		let captured: Uint8Array | null = null;
		peer.on('update', (u: Uint8Array) => (captured = u));
		peer.transact(() => peer.get('meta').setAttr('v', 99));
		const res = S.applyRemote(live, captured!, 'bench');
		expect(res.applied).toBe(false);
		expect(res.problem?.kind).toBe('unsupported');
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
	});

	it('a same-value stamp rewrite applies', () => {
		const live = buildLive();
		const peer = new Y.Doc({ guid: 'staging-bench' });
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		let captured: Uint8Array | null = null;
		peer.on('update', (u: Uint8Array) => (captured = u));
		peer.transact(() => peer.get('meta').setAttr('v', SCHEMA_VERSION));
		expect(S.applyRemote(live, captured!, 'bench')).toEqual({ applied: true, problem: null });
		expect(E.schemaVersion(live)).toBe(SCHEMA_VERSION);
	});

	it('a meta attr DELETE carried by the delete set is refused', () => {
		const live = buildLive();
		const before = Y.encodeStateAsUpdate(live);
		const peer = new Y.Doc({ guid: 'staging-bench' });
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		let captured: Uint8Array | null = null;
		peer.on('update', (u: Uint8Array) => (captured = u));
		peer.transact(() => peer.get('meta').deleteAttr('v'));
		const res = S.applyRemote(live, captured!, 'bench');
		expect(res.applied).toBe(false);
		expect(res.problem?.kind).toBe('unversioned');
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
	});

	// D-2 / R13: a registry write carries no stamp, so it is not refused at
	// ingress; the doc becomes unversioned — read-only — and a versioned
	// state arriving later makes it writable again.
	it('a blocks-root write on a clean doc applies; the doc is read-only until a stamp arrives', () => {
		const live = new Y.Doc({ guid: 'staging-bench' });
		const rogue = new Y.Doc({ guid: 'other' });
		rogue.get('blocks').setAttr(
			'rogue',
			(() => {
				const n = new Y.Node('block');
				n.setAttr('id', 'rogue');
				n.setAttr('type', 'paragraph');
				return n;
			})()
		);
		expect(S.applyRemote(live, Y.encodeStateAsUpdate(rogue), 'bench')).toEqual({
			applied: true,
			problem: null
		});
		expect(checkSchema(live)?.kind).toBe('unversioned');
		const stamped = new Y.Doc();
		E.init(stamped);
		expect(S.applyRemote(live, Y.encodeStateAsUpdate(stamped), 'bench').applied).toBe(true);
		expect(checkSchema(live)).toBeNull();
	});

	it('a pending forged rewrite is refused when its own stamp write is forged', () => {
		const live = buildLive();
		const peer = new Y.Doc({ guid: 'staging-bench' });
		peer.clientID = Number.MAX_SAFE_INTEGER;
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		const captured: Uint8Array[] = [];
		peer.on('update', (u: Uint8Array) => captured.push(u));
		peer.transact(() => peer.get('meta').setAttr('v', SCHEMA_VERSION + 1)); // another generation
		peer.transact(() => peer.get('meta').setAttr('v', 99));
		const [uMid, uLate] = captured;
		// uLate's dep is missing: it cannot be judged and pends in the engine.
		expect(S.applyRemote(live, uLate, 'bench').applied).toBe(true);
		expect(E.schemaVersion(live)).toBe(SCHEMA_VERSION);
		// uMid itself forges the stamp: refused, so the pending tail stays pending.
		const before = Y.encodeStateAsUpdate(live);
		expect(S.applyRemote(live, uMid, 'bench').problem?.kind).toBe('unsupported');
		expect(E.schemaVersion(live)).toBe(SCHEMA_VERSION);
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
	});

	it('a forged stamp that slips in through pending resolution leaves the document read-only', () => {
		const document = createDocument({
			value: { children: [{ id: 'p', type: 'paragraph', content: [{ text: 'x' }] }] }
		});
		const live = document.doc;
		const peer = new Y.Doc();
		peer.clientID = Number.MAX_SAFE_INTEGER;
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		const captured: Uint8Array[] = [];
		peer.on('update', (u: Uint8Array) => captured.push(u));
		peer.transact(() => peer.get('meta').setAttr('v', SCHEMA_VERSION)); // a same-value rewrite
		peer.transact(() => peer.get('meta').setAttr('v', 99)); // forged, over it
		const [uMid, uLate] = captured;
		const signals: boolean[] = [];
		document.onWritableChange((w) => signals.push(w));
		S.applyRemote(live, uLate, 'bench'); // pends: not judgeable
		expect(S.applyRemote(live, uMid, 'bench').applied).toBe(true); // legit; resolves uLate
		expect(E.schemaVersion(live)).toBe(99);
		expect(document.writable).toBe(false);
		expect(signals).toEqual([false]);
		expect(() => document.transact(() => document.facade.insertText('p', 0, '!'))).toThrow(
			SchemaMismatchError
		);
		document.destroy();
	});

	it('a corrupt payload is reported and mutates nothing', () => {
		const live = buildLive();
		const before = Y.encodeStateAsUpdate(live);
		const errors: unknown[] = [];
		const res = S.applyRemote(
			live,
			new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]),
			'bench',
			(e: Error) => errors.push(e)
		);
		expect(res).toEqual({ applied: false, problem: null });
		expect(errors.length).toBe(1);
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
	});
});
