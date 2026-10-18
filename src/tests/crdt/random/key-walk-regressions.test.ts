/**
 * The index's order keys (`text/index/placement.ts` `keyFor`): a placed
 * block's key sits between the key of the nearest block shown before its
 * place in the sequence and the next key of the list. The walk places a
 * pending neighbour first, and placing one can close a cycle that drops a
 * block back where it stood (fork patch YP22's fallback: its previous record,
 * else home) — into the stretch the walk had already passed. The wide corpus
 * (seeds 1–1,000, 300 ops) found four schedules where the key was read from
 * the stale walk and the maintained order differed from its rebuild (the
 * lanes' index self-checks threw): the doc, model, roles and tables adapters.
 * A walk under which a placement changed now walks again. These rows pin the
 * minimized schedules; the self-checks are the oracle (every fold's
 * maintained order equals the rebuild's).
 *
 * The same walk placed its neighbours after the block's cycle check: one of
 * them could close a cycle through the block that no check saw (doc seed
 * 217: the display tree held b3 under b3b under b3, and the change report's
 * walk up the tree never ended). The key is now found first and the cycle
 * check reads the neighbours placed; the last row pins the schedule's first
 * 98 steps.
 */
// @ts-nocheck -- tests drive the runner through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runSchedule } from './runner.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { createDocOps, ROLES, TABLES } from '../harness/ops/doc-ops.js';
import { MODEL_BASE_SEED, ROLES_BASE_SEED, TABLES_BASE_SEED } from '../scenarios/seeds.js';

const ADAPTERS = {
	doc: () => [createDocOps(), MODEL_BASE_SEED],
	model: () => [createModelOps(), MODEL_BASE_SEED],
	roles: () => [createDocOps(ROLES), ROLES_BASE_SEED],
	tables: () => [createDocOps(TABLES), TABLES_BASE_SEED]
} as const;

describe('order keys: a walk that a cycle fallback changed under it walks again', () => {
	for (const [seed, adapter] of [
		[126, 'doc'],
		[360, 'model'],
		[7, 'roles'],
		[423, 'tables']
	] as const)
		it(`seed ${seed} (${adapter} adapter): the maintained order equals its rebuild after every fold`, () => {
			const file = JSON.parse(
				readFileSync(
					new URL(`./regressions/key-walk-${seed}.${adapter}.json`, import.meta.url),
					'utf8'
				)
			);
			const [ops, base] = ADAPTERS[adapter]();
			const r = runSchedule({ seed: file.seed, peers: file.peers, steps: file.steps }, ops, base);
			expect(r.failure).toBeUndefined();
			expect(r.ok).toBe(true);
		});
});

describe('the cycle check reads the neighbours the key walk placed', () => {
	it('seed 217 (doc adapter, first 98 steps): no cycle in the display tree, the order equals its rebuild', () => {
		const file = JSON.parse(
			readFileSync(new URL('./regressions/cycle-check-217.doc.json', import.meta.url), 'utf8')
		);
		const [ops, base] = ADAPTERS.doc();
		const r = runSchedule({ seed: file.seed, peers: file.peers, steps: file.steps }, ops, base);
		expect(r.failure).toBeUndefined();
		expect(r.ok).toBe(true);
	});
});
