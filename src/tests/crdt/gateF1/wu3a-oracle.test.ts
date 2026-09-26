/**
 * Gate-F1 adversarial probes — WU3a strict-oracle honesty.
 *
 * Probe A (F3, moved-vs-stolen): the corpus's atom-fate oracle
 * (`classifyTagAtoms`) used to report every atom under a foreign visible
 * owner as `moved` — unconditional legit evidence — so an ownership steal
 * (the confirmed WU1 `alreadyCovered` bug shape) was indistinguishable
 * from a legal owner-move. The oracle now takes schedule-side causal
 * context: `legitOwners` (every block id a recorded split/merge produced,
 * plus the atoms' home block — the natural owner that reclaims them when
 * a claim holding them dissolves) and `insertOwners` (owners that
 * already claimed the atoms at insert time). An unexplained foreign
 * owner reports `stolen` — a hard strict-
 * lane verdict (`stolen-edit`), never evidence.
 *
 * Probe B (F4, sawLoss is no longer run-global): `runner.ts` used to
 * classify ANY atom hard on EVERY replica as `convergent-loss` whenever
 * ANY lossy reload had run (`sawLoss || hasDestroyedPendingDeps`). The
 * excuse is now correlated: the atom's own id or one of its coverage deps
 * must intersect `lostRanges` (destroyed-by-reload ids) or the
 * post-barrier stranded-pending set. The probe pins the source contract.
 *
 * Probe C (F4 injection): a hand-built schedule where one tag's loss is
 * REAL (destroyed by its own peer's stale-snapshot reload → correlated,
 * still `convergent-loss`) while unrelated tags are injected `uncovered`
 * on every replica — they must report `lost-edit`, not be excused by the
 * lossy reload that happened elsewhere in the same run.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { createPeerPair, type Peer } from '../harness/peer-set.js';
import { createDocOps } from '../harness/ops/doc-ops.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { classifyTagAtoms, locateTagAtoms } from '../harness/ops/model-ops.js';
import { expectedViolations, runSchedule } from '../random/runner.js';
import { MODEL_BASE_SEED } from '../scenarios/seeds.js';
import type { Schedule } from '../random/generator.js';
import type { CrdtOps } from '../harness/ops/crdt-ops.js';

const E = bindEdytorDoc(Y);
const ops = createDocOps();

const facades = new WeakMap<InstanceType<typeof Y.Doc>, ReturnType<typeof E.create>>();
const ed = (peer: Peer) => {
	let f = facades.get(peer.doc);
	if (!f) {
		f = E.create(peer.doc);
		facades.set(peer.doc, f);
	}
	return f;
};
const text = (peer: Peer, id: string) => ed(peer).blockText(id);

const SEED_VC = (doc) => {
	E.init(doc, {
		content: [
			{ id: 'v', type: 'paragraph', content: [{ kind: 'text', text: 'abc' }] },
			{ id: 'c', type: 'paragraph', content: [{ kind: 'text', text: '' }] }
		]
	});
};

/** The confirmed WU1 steal shape — post-F1-fix the insert revives for v. */
const stageSteal = (peer: Peer) => {
	ops.mergeBlocks(peer, 'v', 'c');
	ops.splitBlock(peer, 'c', 1, 'thief');
	ops.deleteBlock(peer, 'c');
	ops.deleteText(peer, 'v', 0, 1);
};

describe('gateF1 WU3a probe A — the oracle distinguishes moved from stolen', () => {
	it('post-F1 the insert owns its atoms; unexplained owners report `stolen`', () => {
		const set = createPeerPair(SEED_VC);
		const { A } = set;
		stageSteal(A);
		expect(text(A, 'v')).toBe('');

		// F1 FIXED: 'X' typed into v is claimed by the revive record — the
		// rival's g1 coverage wins the pre-existing atoms but NOT the append.
		ops.insertText(A, 'v', 0, 'X');
		expect(text(A, 'v')).toBe('X');
		expect(text(A, 'thief')).toBe('bc');

		const found = locateTagAtoms(A, 'X');
		expect(found).not.toBeNull();
		// The atoms are owned by the intended target — `present`, no context
		// needed.
		for (const f of classifyTagAtoms(A, 'v', found!.atoms)) {
			expect(f.kind).toBe('present');
		}

		// Now force a REAL ownership transfer: merge v into a third block so
		// z claims T_v (and X with it) — a causal-op-explained move.
		ops.insertBlock(A, { parent: null, index: 99 }, { id: 'z', type: 'paragraph' });
		ops.mergeBlocks(A, 'v', 'z');
		const fatesMoved = classifyTagAtoms(A, 'v', found!.atoms, {
			legitOwners: new Set(['z'])
		});
		for (const f of fatesMoved) {
			expect(f.kind).toBe('moved');
			expect((f as { owner?: string }).owner).toBe('z');
		}

		// The same final state under an EMPTY legit-owner set is an
		// unexplained transfer → `stolen`, and an owner that already claimed
		// the atoms at insert time is `stolen` even when it is also in
		// legitOwners (the at-birth steal dominates).
		for (const f of classifyTagAtoms(A, 'v', found!.atoms, { legitOwners: new Set() })) {
			expect(f.kind).toBe('stolen');
			expect((f as { owner?: string }).owner).toBe('z');
		}
		for (const f of classifyTagAtoms(A, 'v', found!.atoms, {
			legitOwners: new Set(['z']),
			insertOwners: new Set(['z'])
		})) {
			expect(f.kind).toBe('stolen');
		}

		// Runner verdict wiring: `moved-edit` stays legit evidence;
		// `stolen-edit` is NOT in the expected set → a hard failure.
		const legit = expectedViolations(ops);
		expect(legit.has('moved-edit')).toBe(true);
		expect(legit.has('stolen-edit')).toBe(false);
		expect(legit.has('lost-edit')).toBe(false);
	});
});

describe('gateF1 WU3a probe B — convergent-loss is atom-correlated, not run-global', () => {
	it('the runner source excuses hard fates only through lostRanges/stranded deps', async () => {
		// Static probe: pin the exact mechanism so a refactor that silently
		// reintroduces the run-global excuse is caught.
		const src = await import('node:fs').then((fs) =>
			fs.readFileSync(new URL('../random/runner.ts', import.meta.url), 'utf8')
		);
		// The destroyed-id ledger and the correlation test exist…
		expect(src).toContain('lostRanges');
		expect(src).toContain('strandedRanges');
		expect(src).toContain('tagAtomDeps');
		expect(src).toContain('depGone');
		// …and the old run-global shortcut is gone from the tag path.
		expect(src).not.toContain('sawLoss || hasDestroyedPendingDeps(peers, sawLoss))');
	});
});

describe('gateF1 WU3a probe C — an unrelated lossy reload excuses nothing', () => {
	it('correlated loss stays convergent-loss; unrelated hard fates stay lost-edit', () => {
		const model = createModelOps();
		// peer1 persists, writes tag µLOSS locally, then reloads the STALE
		// snapshot — a real lossy reload that destroys peer1's own items
		// (µLOSS's atoms land inside `lostRanges`). peer0's tags are
		// unaffected: their atoms and coverage deps were never destroyed.
		const schedule: Schedule = {
			seed: 7701,
			peers: 2,
			steps: [
				{ peer: 0, op: { kind: 'insertText', idIndex: 0, offset: 0, text: 'µINJ', tag: 'µINJ' } },
				{ peer: 1, op: { kind: 'net', action: 'persist', a: 1, b: 0 } },
				{ peer: 1, op: { kind: 'insertBlock', id: 'lx1', type: 'paragraph' } },
				{ peer: 1, op: { kind: 'insertText', idIndex: 5, offset: 0, text: 'µLOSS', tag: 'µLOSS' } },
				{ peer: 1, op: { kind: 'net', action: 'reloadSnap', a: 1, b: 0 } },
				{ peer: 0, op: { kind: 'insertText', idIndex: 1, offset: 0, text: 'µINJ2', tag: 'µINJ2' } }
			]
		};
		// Inject the defect at the ADAPTER surface: every tracked atom
		// reports `uncovered` on every replica. With the pre-F4 runner the
		// reloadSnap above would excuse ALL of them as convergent-loss.
		const injected: CrdtOps = {
			...model,
			classifyTagAtoms: (_peer, _target, atoms) => atoms.map(() => ({ kind: 'uncovered' }) as const)
		};
		const res = runSchedule(schedule, injected, MODEL_BASE_SEED);
		expect(res.ok).toBe(false);
		// µINJ/µINJ2: uncovered on every replica, no destroyed dep → REAL loss.
		expect(res.violations).toContain('lost-edit');
		// µLOSS: uncovered everywhere BUT its atoms were destroyed by the
		// observed reload → the correlation still explains it → evidence.
		expect(res.evidence).toContain('convergent-loss');
		expect(res.tagVerdicts['µLOSS']).toContain('convergent-loss');
		expect(res.tagVerdicts['µINJ']).toContain('lost-edit');
	});
});
