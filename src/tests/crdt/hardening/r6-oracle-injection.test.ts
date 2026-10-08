/**
 * HARDENING U0 / R6 — random-runner oracle accepts injected faults as legit
 * (review `docs/archive/crdt-v14-follow-up-review-2026-09-21.md` §R6, P1).
 *
 * The strict oracle classifies tag atoms by FATE alone, without checking
 * whether the schedule ever authorized that fate:
 *
 *   a) `tombstoned` atoms → evidence `deleted-legit` — even when NO delete
 *      op in the schedule covered them. An adapter that silently deletes
 *      inside `setMark` passes the gate.
 *   b) `moved` atoms under any `legitOwners` member (any recorded split/merge
 *      destination) → evidence `moved-edit` — even when the move was caused
 *      by an UNRECORDED structural op injected inside `setMark`. The causal
 *      context says "this owner may legitimately hold atoms", not "this op
 *      moved them".
 *
 * OBSERVED today (vitest run, this file):
 *   R6a: ok=true, violations=[], evidence=['deleted-legit'],
 *        verdict 'µINJ' = 'deleted-legit [tombstoned,tombstoned,tombstoned,tombstoned]'
 *   R6b: ok=true, violations=[], evidence=['moved-edit'],
 *        verdict 'µMV' = 'moved-edit [moved:sp-unrel,moved:sp-unrel,moved:sp-unrel]'
 *
 * These tests assert the CORRECTED runner behavior — `ok:false` with a hard
 * violation (lost-edit / stolen-edit or the U5 equivalents) — so they are RED
 * until the oracle checks causal authorization, not just end-state fate.
 */
// @ts-nocheck -- harness types are exercised through intentionally bad adapters.
import { describe, expect, test } from 'vitest';
import { runSchedule } from '../random/runner.js';
import type { Schedule } from '../random/generator.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';
import type { CrdtOps } from '../harness/ops/crdt-ops.js';

describe('R6 — oracle must reject faults the schedule never requested', () => {
	test('R6a: setMark that also deletes the tracked range is not deleted-legit', () => {
		const model = createModelOps();
		// b1 = 'µINJ' (4 tagged atoms); the setMark step only asks for a mark —
		// the adapter additionally deletes the very range it was asked to mark.
		const schedule: Schedule = {
			seed: 9902,
			peers: 2,
			steps: [
				{ peer: 0, op: { kind: 'insertBlock', id: 'b1', type: 'paragraph' } },
				{ peer: 0, op: { kind: 'insertText', idIndex: 0, offset: 0, text: 'µINJ', tag: 'µINJ' } },
				{ peer: 0, op: { kind: 'setMark', idIndex: 0, offset: 0, length: 4, name: 'b' } }
			]
		};
		const sneaky: CrdtOps = {
			...model,
			setMark: (peer, id, offset, length, name, value) => {
				const ok = model.setMark(peer, id, offset, length, name, value);
				model.deleteText(peer, id, offset, length); // UNREQUESTED deletion
				return ok;
			}
		};
		const res = runSchedule(schedule, sneaky, MODEL_BASE_SEED);
		// OBSERVED: ok=true — the tombstoned atoms were recorded as
		// 'deleted-legit' evidence although no delete op exists in the
		// schedule. Expected: a hard violation (lost-edit family).
		expect(
			res.ok,
			`runner accepted an unrequested deletion: ${JSON.stringify(res.verdicts ?? res)}`
		).toBe(false);
		expect(res.violations.length).toBeGreaterThan(0);
	});

	test('R6b: setMark that merges the tagged block into an unrelated split destination is not moved-edit', () => {
		const model = createModelOps();
		// b1 = 'µMV' (3 tagged atoms); b2 = 'xx' split at 1 → 'sp-unrel' is a
		// RECORDED split destination, i.e. a legitOwners member. The setMark
		// step only asks for a mark — the adapter additionally merges b1 into
		// sp-unrel, moving the tagged atoms under a legit owner through an
		// unrecorded op.
		const schedule: Schedule = {
			seed: 9903,
			peers: 2,
			steps: [
				{ peer: 0, op: { kind: 'insertBlock', id: 'b1', type: 'paragraph' } },
				{ peer: 0, op: { kind: 'insertText', idIndex: 0, offset: 0, text: 'µMV', tag: 'µMV' } },
				{ peer: 0, op: { kind: 'insertBlock', id: 'b2', type: 'paragraph' } },
				// tag === text: the oracle locates tracked atoms by substring.
				{ peer: 0, op: { kind: 'insertText', idIndex: 1, offset: 0, text: 'µXX', tag: 'µXX' } },
				{ peer: 0, op: { kind: 'split', idIndex: 1, offset: 1, newId: 'sp-unrel' } },
				{ peer: 0, op: { kind: 'setMark', idIndex: 0, offset: 0, length: 3, name: 'b' } }
			]
		};
		const sneaky: CrdtOps = {
			...model,
			setMark: (peer, id, offset, length, name, value) => {
				const ok = model.setMark(peer, id, offset, length, name, value);
				model.mergeBlocks(peer, 'b1', 'sp-unrel'); // UNREQUESTED structural move
				return ok;
			}
		};
		const res = runSchedule(schedule, sneaky, MODEL_BASE_SEED);
		// OBSERVED: ok=true — atoms under 'sp-unrel' classified 'moved' because
		// the recorded split made it a legit owner; the injected merge that
		// actually moved them is invisible to the oracle. Expected: a hard
		// violation (stolen-edit family).
		expect(
			res.ok,
			`runner accepted an unrequested merge: ${JSON.stringify(res.verdicts ?? res)}`
		).toBe(false);
		expect(res.violations.length).toBeGreaterThan(0);
	});
});
