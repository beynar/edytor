/**
 * GATE H adversarial probes — R6 (oracle fault-injection strength).
 *
 * The pinned R6 tests prove the intent layer catches unrequested DELETEs
 * and unrequested MERGEs injected inside `setMark`. These probes attack
 * the envelope's blind spots — all now CLOSED by the strict oracle:
 *
 *  1. WRONG MARK VALUE on the right atoms/keys — envelopes now bind
 *     expected VALUES per atom (`marks` is `Map<atomKey, Map<key, canon>>`
 *     not a key set), and the barrier's mark ledger is read: a changed
 *     value that no intent authorized is `mutated-edit`.
 *
 *  2. WRONG OFFSET insert — `atomsIn` now binds the fresh atom ids AND
 *     the display-offset window they must land in; atoms written at a
 *     stale offset are flagged even when the text payload matches.
 *
 *  3. FALSE-RETURN foreign write — `runDocOp` diffs EVERY peer's state
 *     pre/post; a falsy op that mutates any peer (including a foreign
 *     one reached via `peer.set.peers`) is `unrequested-effect`.
 *
 *  4. POSITIVE CONTROL — an EXTRA undo injected inside setMark while the
 *     schedule legitimately tracks history: the resurrection lands outside
 *     setMark's envelope → must be caught.
 *
 *  5. HIDDEN UNDO — an injected undo that reverts the op's own writes
 *     leaves an empty state diff; runDocOp detects it via undo/redo
 *     stack churn on the executing peer.
 */
// @ts-nocheck -- harness types are exercised through intentionally bad adapters.
import { describe, expect, test } from 'vitest';
import { runSchedule } from '../random/runner.js';
import type { Schedule } from '../random/generator.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';
import type { CrdtOps } from '../harness/ops/crdt-ops.js';

describe('gateH-R6 — envelope blind spots', () => {
	test('R6v: setMark writing a WRONG VALUE on the right atoms is rejected', () => {
		const model = createModelOps();
		const schedule: Schedule = {
			seed: 9904,
			peers: 2,
			steps: [
				{ peer: 0, op: { kind: 'insertBlock', id: 'b1', type: 'paragraph' } },
				{ peer: 0, op: { kind: 'insertText', idIndex: 0, offset: 0, text: 'µVAL', tag: 'µVAL' } },
				{ peer: 0, op: { kind: 'setMark', idIndex: 0, offset: 0, length: 4, name: 'b' } }
			]
		};
		// The op was asked to set b=true. The adapter sets b='CORRUPTED' —
		// same key, same atoms, wrong value. FIXED: the value-bound marks
		// envelope rejects it at the op (and the barrier mark ledger would
		// name it `mutated-edit`).
		const sneaky: CrdtOps = {
			...model,
			setMark: (peer, id, offset, length, name, _value) =>
				model.setMark(peer, id, offset, length, name, 'CORRUPTED')
		};
		const res = runSchedule(schedule, sneaky, MODEL_BASE_SEED);
		console.log(
			`[r6-value] ok=${res.ok} violations=${JSON.stringify(res.violations)} ` +
				`verdicts=${JSON.stringify(res.tagVerdicts)}`
		);
		expect(res.ok, 'oracle accepted a wrong mark value the schedule never wrote').toBe(false);
	});

	test('R6o: insertText at the WRONG OFFSET is rejected', () => {
		const model = createModelOps();
		const schedule: Schedule = {
			seed: 9905,
			peers: 2,
			steps: [
				{ peer: 0, op: { kind: 'insertBlock', id: 'b1', type: 'paragraph' } },
				{ peer: 0, op: { kind: 'insertText', idIndex: 0, offset: 0, text: 'abcd', tag: 'abcd' } },
				// Schedule says offset 1; adapter inserts at offset 3 — the
				// tagged atoms exist, count matches, but the FIXED intent
				// binds the display-offset window they must land in.
				{ peer: 0, op: { kind: 'insertText', idIndex: 0, offset: 1, text: 'XY', tag: 'XY' } }
			]
		};
		const sneaky: CrdtOps = {
			...model,
			insertText: (peer, id, offset, text) =>
				model.insertText(peer, id, offset === 1 ? 3 : offset, text)
		};
		const res = runSchedule(schedule, sneaky, MODEL_BASE_SEED);
		console.log(
			`[r6-offset] ok=${res.ok} violations=${JSON.stringify(res.violations)} ` +
				`verdicts=${JSON.stringify(res.tagVerdicts)}`
		);
		expect(res.ok, 'oracle accepted a wrong-offset insert the schedule never wrote').toBe(false);
	});

	test('R6f: op reporting failure while writing on a FOREIGN peer is rejected', () => {
		const model = createModelOps();
		const schedule: Schedule = {
			seed: 9906,
			peers: 2,
			steps: [
				{ peer: 0, op: { kind: 'insertBlock', id: 'b1', type: 'paragraph' } },
				{ peer: 0, op: { kind: 'insertBlock', id: 'b2', type: 'paragraph' } },
				{ peer: 0, op: { kind: 'insertText', idIndex: 0, offset: 0, text: 'µFW', tag: 'µFW' } }
			]
		};
		const sneaky: CrdtOps = {
			...model,
			insertText: (peer, id, offset, text) => {
				// Stale-peer-reference bug: write through a peer captured from
				// `peer.set.peers` (TS-private but reachable at runtime), then
				// report failure. FIXED: runDocOp diffs every peer — the
				// foreign write is flagged `unrequested-effect`.
				const foreign = peer.set.peers.find((p: never) => p !== peer);
				if (foreign) {
					model.insertText(foreign, 'b2', 0, text);
					return false;
				}
				return model.insertText(peer, id, offset, text);
			}
		};
		let finalProjection: unknown = null;
		const res = runSchedule(schedule, sneaky, MODEL_BASE_SEED, {
			inspectAfter: (peers) => {
				finalProjection = peers.map((p) => JSON.stringify(model.project(p)));
			}
		});
		// Airtightness: the foreign write really landed AND converged.
		const proj = finalProjection as string[];
		const foreignLanded = proj.every((p) => p.includes('µFW'));
		console.log(
			`[r6-foreign] ok=${res.ok} violations=${JSON.stringify(res.violations)} ` +
				`verdicts=${JSON.stringify(res.tagVerdicts)} foreignLanded=${foreignLanded}`
		);
		expect(foreignLanded).toBe(true); // the unrequested write converged
		expect(res.ok, 'oracle accepted an unrequested foreign-peer write').toBe(false);
	});

	test('R6c (control): an EXTRA undo inside setMark is caught while history is tracked', () => {
		const model = createModelOps();
		const schedule: Schedule = {
			seed: 9907,
			peers: 2,
			steps: [
				{ peer: 0, op: { kind: 'insertBlock', id: 'b1', type: 'paragraph' } },
				{ peer: 0, op: { kind: 'insertText', idIndex: 0, offset: 0, text: 'µCTL', tag: 'µCTL' } },
				{ peer: 0, op: { kind: 'deleteText', idIndex: 0, offset: 0, length: 2 } },
				// A legit undo step forces trackHistory upfront — so when the
				// sneaky setMark injects a SECOND undo, the stack is live.
				{ peer: 0, op: { kind: 'undo' } },
				{ peer: 0, op: { kind: 'setMark', idIndex: 0, offset: 0, length: 1, name: 'b' } }
			]
		};
		const sneaky: CrdtOps = {
			...model,
			setMark: (peer, id, offset, length, name, value) => {
				// Inject BEFORE the mark so undo pops the next-oldest stack
				// item (the scheduled undo already consumed the deleteText
				// item; this pops insertText → tombstones display atoms).
				model.undo?.(peer);
				return model.setMark(peer, id, offset, length, name, value);
			}
		};
		const res = runSchedule(schedule, sneaky, MODEL_BASE_SEED);
		console.log(
			`[r6-ctrl] ok=${res.ok} violations=${JSON.stringify(res.violations)} ` +
				`intents=${JSON.stringify(res.intentViolations)}`
		);
		// The envelope must still reject unrequested history effects.
		expect(res.ok).toBe(false);
	});

	test('R6s: an injected undo that silently REVERTS the requested setMark is rejected', () => {
		// The undo runs AFTER model.setMark commits — it pops the setMark's
		// own just-pushed stack item and reverts it. The net doc-state diff
		// is empty (tombstoned format markers are not atoms), so state diff
		// alone cannot see it. FIXED: runDocOp snapshots the executing
		// peer's undo/redo stacks — a non-history op must never pop the
		// undo stack nor push/swap the redo stack top.
		const model = createModelOps();
		const schedule: Schedule = {
			seed: 9908,
			peers: 2,
			steps: [
				{ peer: 0, op: { kind: 'insertBlock', id: 'b1', type: 'paragraph' } },
				{ peer: 0, op: { kind: 'insertText', idIndex: 0, offset: 0, text: 'µSW', tag: 'µSW' } },
				// delete+undo forces trackHistory upfront AND leaves the
				// atoms live — the setMark below lands on real atoms, then
				// the injected post-commit undo pops the setMark's own
				// just-pushed stack item and reverts it inside the same op.
				{ peer: 0, op: { kind: 'deleteText', idIndex: 0, offset: 0, length: 1 } },
				{ peer: 0, op: { kind: 'undo' } },
				{ peer: 0, op: { kind: 'setMark', idIndex: 0, offset: 0, length: 3, name: 'b' } }
			]
		};
		const sneaky: CrdtOps = {
			...model,
			setMark: (peer, id, offset, length, name, value) => {
				const ok = model.setMark(peer, id, offset, length, name, value);
				model.undo?.(peer); // reverts the mark we just applied
				return ok;
			}
		};
		const res = runSchedule(schedule, sneaky, MODEL_BASE_SEED);
		console.log(
			`[r6-swallow] ok=${res.ok} violations=${JSON.stringify(res.violations)} ` +
				`verdicts=${JSON.stringify(res.tagVerdicts)}`
		);
		expect(res.ok, 'oracle accepted a setMark whose effect was silently reverted').toBe(false);
	});
});
