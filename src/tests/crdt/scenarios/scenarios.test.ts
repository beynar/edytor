/**
 * Green-lane runner for the ACTIVE §8 scenarios (U02).
 *
 * Every registered {@link Scenario} runs through the replica harness +
 * `RawNodeOps`. The completeness test pins the contract: each §8 requirement
 * id must be either active here or registered pending with an owning unit —
 * nothing may silently drop out of the matrix.
 */
import { describe, expect, it } from 'vitest';
import { SECTION8_IDS } from './registry.js';
import { activeScenarios } from './active.js';
import { modelScenarios } from './active-model.js';
import { textScenarios } from './active-text.js';
import { richtextScenarios } from './active-richtext.js';
import { docScenarios } from './active-doc.js';
import { pendingScenarios } from './pending.js';

const allActive = [
	...activeScenarios,
	...modelScenarios,
	...textScenarios,
	...richtextScenarios,
	...docScenarios
];

describe('§8 active scenarios (raw-node adapter)', () => {
	for (const scenario of activeScenarios) {
		it(`[${scenario.id}] ${scenario.title}`, () => scenario.run());
	}
});

describe('§8 active scenarios (placement model / U03)', () => {
	for (const scenario of modelScenarios) {
		it(`[${scenario.id}] ${scenario.title}`, () => scenario.run());
	}
});

describe('§8 active scenarios (text ownership / U04)', () => {
	for (const scenario of textScenarios) {
		it(`[${scenario.id}] ${scenario.title}`, () => scenario.run());
	}
});

describe('§8 active scenarios (rich text / U05)', () => {
	for (const scenario of richtextScenarios) {
		it(`[${scenario.id}] ${scenario.title}`, () => scenario.run());
	}
});

describe('§8 active scenarios (assembled doc / U06)', () => {
	for (const scenario of docScenarios) {
		it(`[${scenario.id}] ${scenario.title}`, () => scenario.run());
	}
});

describe('§8 registry completeness', () => {
	it('every §8 requirement id is active or explicitly pending', () => {
		const activeReqs = new Set(allActive.map((s) => s.requirement));
		const pendingIds = new Set(pendingScenarios.map((s) => s.id));
		const uncovered = SECTION8_IDS.filter((id) => !activeReqs.has(id) && !pendingIds.has(id));
		expect(uncovered).toEqual([]);
	});

	it('scenario ids are unique; pending rows carry an owning unit', () => {
		const ids = allActive.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const p of pendingScenarios) {
			expect(p.owner, `pending ${p.id} missing owner`).toMatch(/^U\d{2}$/);
			expect(p.reason.length).toBeGreaterThan(0);
		}
	});

	it('pending entries reference real §8 ids', () => {
		const known = new Set<string>(SECTION8_IDS);
		for (const p of pendingScenarios) {
			expect(known.has(p.id), `pending entry ${p.id} is not a §8 id`).toBe(true);
		}
	});
});
