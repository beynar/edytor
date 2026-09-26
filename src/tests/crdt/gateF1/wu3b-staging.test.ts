/**
 * Gate-F1 measurement probe — WU3b `applyUpdateStaged` cost.
 *
 * The schema boundary stages EVERY inbound remote update: a throwaway
 * Y.Doc is built, the LIVE doc's full state is encoded into it
 * (`Y.encodeStateAsUpdate(doc)`), the incoming update is applied on top,
 * `checkSchema` runs on the merged scratch, and only then does the update
 * apply to the live doc. Both providers route SyncStep2 AND messageYjsUpdate
 * through it — there is no fast path for updates that do not touch `meta`.
 *
 * This probe quantifies the cost on a 1,000-block document across a burst
 * of 100 single-keystroke remote updates, and reports:
 *   - staged vs direct per-update wall time;
 *   - the full-state encode size (bytes shipped to the scratch doc);
 *   - schema-check and scratch-apply split of the staged cost.
 *
 * It also verifies the correctness edges the review asked for:
 *   - staging happens BEFORE live integration (a refused update leaves the
 *     live store byte-identical);
 *   - a v14-valid update with an UNSUPPORTED schema attribute state is
 *     refused;
 *   - a v14-valid update carrying a FOREIGN meta.schema manifest name is
 *     refused through the same staging path (gate-F1 F5);
 *   - a brand-new peer's SyncStep2 (full state) is staged, not direct.
 *
 * Measurement data is printed, not asserted — the numbers are input to
 * the WU5-WU9 performance work, not a gate.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc, bindSync } from '../../../lib/crdt/index.js';
import { checkSchema } from '../../../lib/crdt/edytor-doc.js';
import type { EngineDoc } from '../../../lib/crdt/engine-api.js';

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

describe('gateF1 WU3b — applyUpdateStaged staging cost', () => {
	it('measures staged vs direct apply across a 100-keystroke burst on 1,000 blocks', () => {
		const live = buildLive();
		const remote = buildRemote(Y.encodeStateAsUpdate(live));
		const red = E.create(remote);
		// Produce BURST one-char inserts on the remote; collect the update log.
		const updates: Uint8Array[] = [];
		remote.on('update', (u: Uint8Array) => updates.push(u));
		for (let i = 0; i < BURST; i++) {
			remote.transact(() => red.insertText(`b${i % BLOCKS}`, 5, 'x'));
		}
		expect(updates.length).toBe(BURST);

		const liveStateBytes = Y.encodeStateAsUpdate(live).byteLength;
		const updateBytes = updates.map((u) => u.byteLength);
		console.log(
			`[WU3b] live doc: ${BLOCKS} blocks, full-state encode = ${liveStateBytes} bytes; ` +
				`incoming updates: ${BURST} × ~${Math.max(...updateBytes)}B (median ` +
				`${updateBytes.sort((a, b) => a - b)[Math.floor(BURST / 2)]}B)`
		);

		// ── what staging used to cost (manual scratch simulation) ──────
		const scratchSim = buildLive();
		let schemaNs = 0;
		let scratchNs = 0;
		const sT0 = performance.now();
		for (const u of updates) {
			const s0 = performance.now();
			const scratch = new Y.Doc();
			Y.applyUpdate(scratch, Y.encodeStateAsUpdate(scratchSim));
			Y.applyUpdate(scratch, u);
			scratchNs += performance.now() - s0;
			const c0 = performance.now();
			checkSchema(scratch as unknown as EngineDoc);
			schemaNs += performance.now() - c0;
			Y.applyUpdate(scratchSim, u, 'bench');
		}
		const manualStagedMs = performance.now() - sT0;

		// ── applyUpdateStaged (WU5 fast path engaged) ──────────────────
		const t0 = performance.now();
		let stagedCount = 0;
		for (const u of updates) {
			const res = S.applyUpdateStaged(live, u, 'bench');
			expect(res.applied).toBe(true);
			if (res.staged) stagedCount++;
		}
		const stagedMs = performance.now() - t0;
		// Keystroke content updates must never reach the scratch path.
		expect(stagedCount).toBe(0);

		// ── direct path (what upstream y-protocols does) ───────────────
		const live2 = buildLive();
		const t1 = performance.now();
		for (const u of updates) Y.applyUpdate(live2, u, 'bench');
		const directMs = performance.now() - t1;

		const perStaged = stagedMs / BURST;
		const perDirect = directMs / BURST;
		console.log(
			`[WU3b] applyUpdateStaged (fast path): ${stagedMs.toFixed(1)}ms total, ` +
				`${perStaged.toFixed(3)}ms/update (${stagedCount}/${BURST} staged); ` +
				`old staged cost (manual scratch): ${manualStagedMs.toFixed(1)}ms total, ` +
				`${(manualStagedMs / BURST).toFixed(2)}ms/update ` +
				`(scratch-build+apply ${(scratchNs / BURST).toFixed(2)}ms + schema ` +
				`${(schemaNs / BURST).toFixed(2)}ms); ` +
				`direct apply: ${directMs.toFixed(1)}ms total, ${perDirect.toFixed(3)}ms/update`
		);
		// Sanity: the staged doc actually integrated the burst.
		expect(E.create(live).blockText('b0')).toContain('x');
	});

	it('a refused update leaves the live doc byte-identical (staging before integration)', () => {
		const live = buildLive();
		const before = Y.encodeStateAsUpdate(live);
		// Forge a v14-envelope-shaped update whose merge leaves meta.v=99.
		// Pin the clientID to the max so the v99 write deterministically wins
		// the LWW merge against the live doc's meta.v=1 (map attrs resolve by
		// clientID — without the pin the refusal was clientID-lottery).
		const poison = new Y.Doc({ guid: 'other' });
		poison.clientID = Number.MAX_SAFE_INTEGER;
		poison.get('meta').setAttr('v', 99);
		const poisonUpdate = Y.encodeStateAsUpdate(poison);
		const res = S.applyUpdateStaged(live, poisonUpdate, 'bench');
		expect(res.applied).toBe(false);
		expect(res.problem).not.toBeNull();
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
	});

	it('a valid-version update carrying a foreign meta.schema is refused', () => {
		const live = buildLive();
		const before = Y.encodeStateAsUpdate(live);
		// meta.v stays the supported version but meta.schema is a foreign
		// document name — the manifest name is part of the schema contract
		// (gate-F1 F5: checkSchema now rejects it through the same staging
		// path as an unsupported version).
		const foreign = new Y.Doc({ guid: 'staging-bench' });
		Y.applyUpdate(foreign, Y.encodeStateAsUpdate(live));
		foreign.get('meta').setAttr('schema', 'not-edytor');
		const diff = Y.encodeStateAsUpdate(foreign, Y.encodeStateVector(live));
		const res = S.applyUpdateStaged(live, diff, 'bench');
		expect(res.applied).toBe(false);
		expect(res.problem?.kind).toBe('foreign');
		// Refused BEFORE mutating the live doc — byte-identical store.
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
		expect(live.get('meta').getAttr('schema')).toBe('edytor-doc');
	});

	it('a brand-new peer SyncStep2 (full state) goes through the same staging path', () => {
		// Truly empty doc — a brand-new peer that never ran init. The remote
		// full state carries meta.v, so the merged scratch is clean.
		const live = new Y.Doc({ guid: 'staging-bench' });
		const remote = buildLive();
		const full = Y.encodeStateAsUpdate(remote);
		const res = S.applyUpdateStaged(live, full, 'bench');
		// The scan flags meta/blocks root writes → the scratch path ran.
		expect(res.staged).toBe(true);
		expect(res.applied).toBe(true);
		expect(E.create(live).childrenIds(null).length).toBe(BLOCKS);
	});

	it('a meta.v OVERWRITE (parentless wire item) is caught and staged', () => {
		const live = buildLive();
		const before = Y.encodeStateAsUpdate(live);
		// A peer seeded with the live state rewrites meta.v in place — the
		// wire item carries no parent/parentSub (origin-encoded), so only
		// the scan's left-chain resolution can see it lands under `meta`.
		const peer = new Y.Doc({ guid: 'staging-bench' });
		peer.clientID = Number.MAX_SAFE_INTEGER;
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		let captured: Uint8Array | null = null;
		peer.on('update', (u: Uint8Array) => (captured = u));
		peer.transact(() => peer.get('meta').setAttr('v', 99));
		const res = S.applyUpdateStaged(live, captured!, 'bench');
		expect(res.staged).toBe(true);
		expect(res.applied).toBe(false);
		expect(res.problem?.kind).toBe('unsupported');
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
	});

	it('a meta attr DELETE carried by the delete set is staged and refused', () => {
		const live = buildLive();
		const before = Y.encodeStateAsUpdate(live);
		const peer = new Y.Doc({ guid: 'staging-bench' });
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		let captured: Uint8Array | null = null;
		peer.on('update', (u: Uint8Array) => (captured = u));
		// Remote undo of init: the update's delete set covers the live
		// meta.v attr item. Merged doc loses v while the registry stays
		// non-empty → unversioned → refused before mutating live state.
		peer.transact(() => peer.get('meta').deleteAttr('v'));
		const res = S.applyUpdateStaged(live, captured!, 'bench');
		expect(res.staged).toBe(true);
		expect(res.applied).toBe(false);
		expect(res.problem?.kind).toBe('unversioned');
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
	});

	it('a blocks-root write on a clean-but-unversioned doc is staged (registry flip)', () => {
		// Empty live doc: clean (no v, empty registry, no foreign name) —
		// the versioned check in the scan is what flags this write, not the
		// already-broken gate.
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
		const res = S.applyUpdateStaged(live, Y.encodeStateAsUpdate(rogue), 'bench');
		expect(res.staged).toBe(true);
		expect(res.applied).toBe(false);
		expect(res.problem?.kind).toBe('unversioned');
	});

	it('an update that resolves a pending schema write is staged (pendingStructs)', () => {
		const live = buildLive();
		const peer = new Y.Doc({ guid: 'staging-bench' });
		peer.clientID = Number.MAX_SAFE_INTEGER;
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		const captured: Uint8Array[] = [];
		peer.on('update', (u: Uint8Array) => captured.push(u));
		// A meta attr rewrite's left dep is the PRIOR attr item: u_mid's
		// v=2 item is what u_late's v=99 rewrite needs. Delivering u_late
		// without u_mid pends it — its schema write sits in pendingStructs.
		peer.transact(() => peer.get('meta').setAttr('v', 2));
		peer.transact(() => peer.get('meta').setAttr('v', 99));
		expect(captured.length).toBe(2);
		const [uMid, uLate] = captured;
		// u_late's dep (the v=2 item) is missing → scan returns unsure →
		// staged → merged scratch stays clean (pending tail does not
		// integrate) → applied → pends in the LIVE doc too.
		const rLate = S.applyUpdateStaged(live, uLate, 'bench');
		expect(rLate.staged).toBe(true);
		expect(rLate.applied).toBe(true);
		expect(E.schemaVersion(live)).toBe(1);
		// u_mid resolves u_late's dep — the pendingStructs gate keeps it on
		// the staging path so the pending v99 tail is judged BEFORE it can
		// integrate: refused, and neither update lands.
		const before = Y.encodeStateAsUpdate(live);
		const rMid = S.applyUpdateStaged(live, uMid, 'bench');
		expect(rMid.staged).toBe(true);
		expect(rMid.applied).toBe(false);
		expect(rMid.problem?.kind).toBe('unsupported');
		expect(E.schemaVersion(live)).toBe(1);
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
	});

	it('a corrupt payload stays on the staged error path (errorHandler + no mutation)', () => {
		const live = buildLive();
		const before = Y.encodeStateAsUpdate(live);
		const errors: unknown[] = [];
		const res = S.applyUpdateStaged(
			live,
			new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]),
			'bench',
			(e: Error) => errors.push(e)
		);
		expect(res.staged).toBe(true);
		expect(res.applied).toBe(false);
		expect(res.problem).toBeNull();
		expect(errors.length).toBe(1);
		expect(Y.encodeStateAsUpdate(live)).toEqual(before);
	});
});
