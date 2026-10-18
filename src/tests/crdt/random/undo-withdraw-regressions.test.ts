/**
 * `hist.undo.withdraw` — undoing a block's creation keeps what another author
 * put in it. The wide corpus (seeds 1–1,000, 300 ops) found three schedules
 * (model seeds 219, 417 and 889) where an undo that withdraws a block a peer
 * had typed into tombstoned the peer's text and atoms. The document's history
 * (`doc/history.ts`, `placement/model.ts` `withdrawOnUndo`) keeps them; the
 * model lane ran a test copy of the engine's old undo manager without the
 * withdraw rule, so it removed the block whole. Both lanes now run the
 * document's history; these rows pin the minimized schedules on both, and
 * the rule itself through the facade.
 *
 * Expected values come from the contract row, never from running code.
 */
// @ts-nocheck -- tests drive the runner and the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Y } from '../../../lib/crdt/engine.js';
import { bindCrdt, createDocument, loadDocument } from '../../../lib/crdt/index.js';
import { runSchedule } from './runner.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { createDocOps } from '../harness/ops/doc-ops.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';

const crdt = bindCrdt(Y);
const REMOTE = Object.freeze({ regression: 'remote' });

describe('hist.undo.withdraw — the pinned wide-corpus schedules', () => {
	for (const seed of [219, 417, 889])
		for (const [name, make] of [
			['model', createModelOps],
			['doc', createDocOps]
		] as const)
			it(`seed ${seed} (${name} adapter): the undo removes none of the peer's text`, () => {
				const file = JSON.parse(
					readFileSync(new URL(`./regressions/undo-withdraw-${seed}.json`, import.meta.url), 'utf8')
				);
				const r = runSchedule(
					{ seed: file.seed, peers: file.peers, steps: file.steps },
					make(),
					MODEL_BASE_SEED
				);
				expect(r.intentViolations).toEqual([]);
				expect(r.failure).toBeUndefined();
				expect(r.ok).toBe(true);
			});
});

describe('hist.undo.withdraw — through the facade', () => {
	it('Ada creates a block, Bob types into it, Ada undoes: Bob’s text stays, in the block', () => {
		const seed = createDocument({
			value: { children: [{ id: 'p', type: 'paragraph', content: [{ text: 'p' }] }] }
		});
		const update = seed.encode();
		seed.destroy();
		const a = loadDocument(update, { history: { captureTimeout: 0 } });
		const b = loadDocument(update);
		const sync = (from, to) =>
			crdt.sync.applyRemote(
				to.doc,
				Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
				REMOTE
			);
		void a.history;
		a.transact(() =>
			a.facade.insertBlocks({ parent: null, index: 1 }, [
				{ id: 'n', type: 'paragraph', content: [{ kind: 'text', text: 'ada' }] }
			])
		);
		sync(a, b);
		b.facade.insertText('n', 3, ' bob');
		sync(b, a);
		a.history.undo();
		sync(a, b);
		for (const d of [a, b]) {
			expect(d.facade.listBlockIds()).toContain('n');
			expect(d.facade.blockText('n')).toBe(' bob');
		}
		a.destroy();
		b.destroy();
	});
});
