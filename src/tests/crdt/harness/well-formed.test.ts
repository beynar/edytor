/**
 * `wellFormed` oracle sensitivity (review 2026-09-29): every named check
 * fails on the state it exists to catch and stays green on the legitimate
 * shape; the random-corpus runner turns a break at any step into a hard
 * `ill-formed` failure. Inputs are hand-authored.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { afterEach, describe, expect, it } from 'vitest';
import { WELL_FORMED_CHECKS, wellFormedProblems } from './assert/well-formed.js';
import { runSchedule } from '../random/runner.js';
import { createDocOps } from './ops/doc-ops.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';

const b = (id: string, type: unknown = 'paragraph', children = []) => ({ id, type, children });

describe('wellFormed checks', () => {
	it('registers the named checks', () => {
		expect(Object.keys(WELL_FORMED_CHECKS)).toEqual([
			'registered-type',
			'merge-order',
			'void-children',
			'island-kind',
			'seed-displacement',
			'promotion-hidden'
		]);
	});

	it('registered-type: undefined, "", "unknown" and unregistered types fail', () => {
		expect(wellFormedProblems({ roots: [b('A'), b('B', 'quote')] })).toEqual([]);
		expect(wellFormedProblems({ roots: [{ id: 'A' }, b('B', ''), b('C', 'unknown')] })).toEqual([
			'registered-type: A has type undefined',
			'registered-type: B has type ""',
			'registered-type: C has type "unknown"'
		]);
		const registered = new Set(['paragraph']);
		expect(wellFormedProblems({ roots: [b('A', 'quote')], registered })).toEqual([
			'registered-type: A has type "quote"'
		]);
	});

	it('merge-order: the survivor precedes the former children', () => {
		const merges = [{ from: 'X', into: 'P', kids: ['K'] }];
		// The target survives: X K… after P is fine; K above P is not.
		expect(wellFormedProblems({ roots: [b('P'), b('K')], merges })).toEqual([]);
		expect(wellFormedProblems({ roots: [b('K'), b('P')], merges })).toEqual([
			'merge-order: K (child of merged X) ranks before P'
		]);
		// The target died, the source revived (UW-20).
		expect(wellFormedProblems({ roots: [b('X'), b('K')], merges })).toEqual([]);
		expect(wellFormedProblems({ roots: [b('K'), b('X')], merges })).toEqual([
			'merge-order: K (child of merged X) ranks before X'
		]);
	});

	it('void-children: a void block with visible children fails', () => {
		const isVoid = (id: string) => id === 'D';
		expect(wellFormedProblems({ roots: [b('D'), b('P', 'paragraph', [b('K')])], isVoid })).toEqual(
			[]
		);
		expect(wellFormedProblems({ roots: [b('D', 'divider', [b('K')])], isVoid })).toEqual([
			'void-children: void D has visible children'
		]);
	});

	it('island-kind: an island’s child kind outside a block of that island kind fails (RW-01)', () => {
		const islandKinds = new Map([['codeLine', 'code']]);
		const line = (id: string) => b(id, 'codeLine');
		expect(wellFormedProblems({ roots: [b('C', 'code', [line('L')])], islandKinds })).toEqual([]);
		expect(
			wellFormedProblems({ roots: [line('L'), b('P', 'paragraph', [line('K')])], islandKinds })
		).toEqual([
			'island-kind: L shows codeLine outside a code',
			'island-kind: K shows codeLine outside a code'
		]);
	});

	it('seed-displacement: an id changing registry node fails unless the new node succeeds it', () => {
		const identities = new Map<string, string>();
		let node = '1:0';
		const input = (succeeds = () => false) => ({
			roots: [b('P')],
			identityOf: () => node,
			identities,
			succeeds
		});
		expect(wellFormedProblems(input())).toEqual([]);
		node = '2:0';
		expect(wellFormedProblems(input())).toEqual(['seed-displacement: P was node 1:0, now 2:0']);
		expect(
			wellFormedProblems(input((later, earlier) => later === '2:0' && earlier === '1:0'))
		).toEqual([]);
	});

	describe('promotion-hidden (on by default)', () => {
		const saved = process.env.DST_PROMOTION_ORACLE;
		afterEach(() => {
			if (saved === undefined) delete process.env.DST_PROMOTION_ORACLE;
			else process.env.DST_PROMOTION_ORACLE = saved;
		});
		const input = { roots: [], hiddenUnderDeleted: () => ['G'] };

		it('is on by default and off with DST_PROMOTION_ORACLE=0', () => {
			delete process.env.DST_PROMOTION_ORACLE;
			expect(wellFormedProblems(input)).toEqual([
				'promotion-hidden: G hidden under a deleted holder'
			]);
			process.env.DST_PROMOTION_ORACLE = '0';
			expect(wellFormedProblems(input)).toEqual([]);
		});
	});
});

describe('the corpus runner holds every replica to wellFormed after every step', () => {
	it('a step that leaves a typeless block fails the seed as ill-formed', () => {
		const base = createDocOps();
		// An adapter whose insert also strips the new block's type — the UW-01 shape.
		const ops = {
			...base,
			insertBlock: (peer, dest, spec) =>
				base.insertBlock(peer, dest, spec) &&
				peer.transact(() => base.resolveBlock(peer, spec.id).deleteAttr('type')) === undefined
		};
		const schedule = {
			seed: 1,
			peers: 2,
			steps: [{ peer: 0, op: { kind: 'insertBlock', id: 'typeless', type: 'paragraph' } }]
		};
		expect(runSchedule(schedule, base, MODEL_BASE_SEED).ok).toBe(true);
		const result = runSchedule(schedule, ops, MODEL_BASE_SEED);
		expect(result.violations).toEqual(['ill-formed']);
		expect(result.failure).toMatch(/^step 0 ill-formed: A: registered-type: typeless has type/);
	});
});
