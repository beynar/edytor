/**
 * U11 profiling — where does a per-keystroke edit's cost go at 1000 blocks?
 * Temporary measurement test (not part of the acceptance corpus).
 *
 * OPT-IN ONLY — this file asserts nothing and always prints timings, so it
 * is skipped in the normal lane. Run it explicitly:
 *
 *   U11_PROFILE=1 pnpm vitest run src/tests/crdt/u11-profile.test.ts
 */
// @ts-nocheck
import { describe, it } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';
import { bindRuns, bindEdytorDoc } from '../../lib/crdt/index.js';
import { bindModel } from '../oracles/model-ops.js';
import { bindText } from '../../lib/crdt/text/model.js';
import { createPeerPair } from './harness/peer-set.js';
import { modelSpecSeed } from './scenarios/seeds.js';

const M = bindModel(Y);
const R = bindRuns(Y);
const D = bindEdytorDoc(Y);
const T = bindText(Y);

const stats = (arr) => {
	const s = [...arr].sort((a, b) => a - b);
	const q = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
	return {
		p50: +q(50).toFixed(4),
		p95: +q(95).toFixed(4),
		mean: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(4)
	};
};

const seedDoc = (n, chars = 40) =>
	modelSpecSeed(
		Array.from({ length: n }, (_, i) => ({
			id: `b${i}`,
			type: 'paragraph',
			content: [
				{
					kind: 'text',
					text: `block ${i} `.padEnd(chars / 2, 'x'),
					marks: { bold: i % 3 === 0 ? true : undefined }
				},
				{ kind: 'inline', id: `m${i}`, type: 'mention', data: { user: `u${i}` } },
				{ kind: 'text', text: ` tail ${i}`.padEnd(chars / 2, 'y') }
			]
		}))
	);

// Skipped unless explicitly opted in — a profiling scaffold, not a
// regression gate (zero assertions, ~1.3s, prints unconditionally).
describe.skipIf(!process.env.U11_PROFILE)('U11 profile', () => {
	it('decomposes per-keystroke + load + project costs', () => {
		const N = 1000;
		const set = createPeerPair(seedDoc(N));
		const doc = set.A.doc;

		// ── 1. raw model insertText (no views attached) ─────────────────
		{
			const ts = [];
			for (let i = 0; i < 30; i++) {
				const t0 = performance.now();
				set.A.transact(() => M.insertText(doc, 'b500', 1, 'q'));
				ts.push(performance.now() - t0);
			}
			console.log('bare model insertText txn (1000 blk):', stats(ts));
		}

		// decompose: insertText call alone vs transaction commit overhead
		{
			const inner = [];
			const txn = [];
			for (let i = 0; i < 30; i++) {
				const t0 = performance.now();
				set.A.transact(() => {
					const t1 = performance.now();
					M.insertText(doc, 'b501', 1, 'q');
					inner.push(performance.now() - t1);
				});
				txn.push(performance.now() - t0);
			}
			console.log('  insertText call alone:', stats(inner));
			console.log('  full txn (incl commit):', stats(txn));
		}

		// empty transaction commit cost (engine overhead at 1000 blocks)
		{
			const ts = [];
			for (let i = 0; i < 30; i++) {
				const t0 = performance.now();
				set.A.transact(() => {});
				ts.push(performance.now() - t0);
			}
			console.log('  empty txn commit:', stats(ts));
		}

		// ── 2. + runs view attached ──────────────────────────────────────
		const view = R.attach(doc);
		for (let b = 0; b < N; b++) view.runs(`b${b}`);
		{
			const ts = [];
			for (let i = 0; i < 30; i++) {
				const t0 = performance.now();
				set.A.transact(() => M.insertText(doc, 'b777', 1, 'Z'));
				ts.push(performance.now() - t0);
			}
			console.log('insertText txn + runs view (1000 blk):', stats(ts));
		}

		// ── 3. + EdytorDoc facade subscribed (full app path) ─────────────
		const facade = D.create(doc);
		const off = facade.onChange(() => {});
		{
			const ts = [];
			for (let i = 0; i < 30; i++) {
				const t0 = performance.now();
				facade.insertText('b300', 1, 'w');
				ts.push(performance.now() - t0);
			}
			console.log('facade.insertText + onChange (1000 blk):', stats(ts));
		}
		{
			// same but measure inside the update handler only (takeSnap+diff)
			const ts = [];
			const off2 = facade.onChange(() => {});
			for (let i = 0; i < 30; i++) {
				const t0 = performance.now();
				set.A.transact(() => M.insertText(doc, 'b301', 1, 'e'));
				ts.push(performance.now() - t0);
			}
			off2();
			console.log('insertText txn + subscribed facade:', stats(ts));
		}
		off();

		// ── 4. project() cost ────────────────────────────────────────────
		{
			const ts = [];
			for (let i = 0; i < 30; i++) {
				const t0 = performance.now();
				M.project(doc);
				ts.push(performance.now() - t0);
			}
			console.log('M.project(doc) 1000 blk:', stats(ts));
		}
		{
			const ts = [];
			for (let i = 0; i < 30; i++) {
				const t0 = performance.now();
				M.collectBlocks(doc);
				ts.push(performance.now() - t0);
			}
			console.log('  collectBlocks alone:', stats(ts));
		}
		{
			const ts = [];
			const blocks = M.collectBlocks(doc);
			for (let i = 0; i < 30; i++) {
				const t0 = performance.now();
				T.computeOwnership(doc, blocks);
				ts.push(performance.now() - t0);
			}
			console.log('  computeOwnership alone:', stats(ts));
		}

		// ── 5. doc load/hydration ────────────────────────────────────────
		{
			const update = Y.encodeStateAsUpdate(doc);
			const loadTs = [];
			const attachTs = [];
			const projTs = [];
			for (let i = 0; i < 10; i++) {
				const fresh = new Y.Doc();
				const t0 = performance.now();
				Y.applyUpdate(fresh, update);
				loadTs.push(performance.now() - t0);
				const t1 = performance.now();
				const f = D.create(fresh);
				attachTs.push(performance.now() - t1);
				const t2 = performance.now();
				M.project(fresh);
				projTs.push(performance.now() - t2);
				f.dispose?.();
			}
			console.log(`load/hydrate 1000 blk (${update.byteLength}B update):`, {
				applyUpdate: stats(loadTs),
				attachFacade: stats(attachTs),
				firstProject: stats(projTs)
			});
		}

		// ── 6. facade.project() JSON export cost ─────────────────────────
		{
			const ts = [];
			for (let i = 0; i < 15; i++) {
				const t0 = performance.now();
				facade.project();
				ts.push(performance.now() - t0);
			}
			console.log('facade.project() (canonical view) 1000 blk:', stats(ts));
		}
		{
			const ts = [];
			for (let i = 0; i < 10; i++) {
				const t0 = performance.now();
				facade.toJSON ? facade.toJSON() : null;
				ts.push(performance.now() - t0);
			}
			console.log('facade.toJSON() 1000 blk:', stats(ts));
		}
	});
});
