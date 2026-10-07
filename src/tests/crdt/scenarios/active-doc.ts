/**
 * Active §8 scenarios for the U06 assembled document model (EdytorDoc /
 * DocOps adapter).
 *
 * These run in the green lane (`pnpm test:crdt`) via `scenarios.test.ts`.
 * They own SY03's full contract — concurrent deterministic bootstrap and the
 * canonical-root/no-duplicate-placeholder behavior — plus replica-level
 * checks that init does not perturb normal op convergence through the
 * unified surface.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { expect } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { createPeerTriple, createPeerPair } from '../harness/peer-set.js';
import { createDocOps } from '../harness/ops/doc-ops.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';
import { SCHEMA_VERSION } from '../../../lib/crdt/protocol.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { MODEL_BASE_SEED } from './seeds.js';
import type { Scenario } from './registry.js';
import { DEFAULT_SEED_ID } from '../default-seed.js';

const E = bindEdytorDoc(Y);
const ops = createDocOps();

const topIds = (peer) => ops.project(peer).children.map((b) => b.id);

export const docScenarios: Scenario[] = [
	// ── SY03 — deterministic bootstrap ──────────────────────────────────
	{
		id: 'SY03b',
		requirement: 'SY03',
		title: 'three peers init an empty doc concurrently → one canonical bootstrap block',
		run: () => {
			// No seed: every peer starts from a truly empty doc and initializes
			// it independently and concurrently — the canonical root must be
			// written under a shared deterministic key so the engine's LWW
			// dedupes to exactly one survivor.
			const set = createPeerTriple();
			const { A, B, C } = set;
			E.init(A.doc);
			E.init(B.doc);
			E.init(C.doc);
			// Before any sync each peer already sees exactly one block.
			for (const p of set.peers) {
				expect(topIds(p)).toEqual([DEFAULT_SEED_ID]);
			}
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			// Converged: ONE canonical bootstrap block on every replica — never
			// three fallback paragraphs.
			for (const p of set.peers) {
				expect(topIds(p)).toEqual([DEFAULT_SEED_ID]);
				expect(ops.listBlockIds(p)).toEqual([DEFAULT_SEED_ID]);
			}
		}
	},
	{
		id: 'SY03c',
		requirement: 'SY03',
		title: 'independently initialized docs merge without duplicating the bootstrap block',
		run: () => {
			// A and B each initialize offline; C initializes with explicit
			// content. Same-key bootstrap writes dedupe; distinct ids union.
			const set = createPeerTriple();
			const { A, B, C } = set;
			E.init(A.doc);
			E.init(B.doc);
			E.init(C.doc, { content: [{ id: 'c-first', type: 'paragraph' }] });
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			const ids = topIds(A);
			// Bootstrap writes under the reserved key collapse to ≤1 survivor;
			// C's real content joins deterministically.
			expect(ids.filter((i) => i === DEFAULT_SEED_ID)).toHaveLength(1);
			expect(ids).toContain('c-first');
			expect(ids).toHaveLength(2);
			// The schema record converged too — every replica can read it.
			expect(E.schemaVersion(A.doc)).toBe(SCHEMA_VERSION);
			expect(E.schemaVersion(C.doc)).toBe(SCHEMA_VERSION);
		}
	},
	{
		id: 'SY03d',
		requirement: 'SY03',
		title: 'init is idempotent and never rewrites on top of synced content',
		run: () => {
			const set = createPeerPair();
			const { A, B } = set;
			E.init(A.doc);
			set.deliverAll();
			set.syncAll();
			// B synced A's init: its own init must not create a second block.
			E.init(B.doc);
			// Re-init on A is a no-op beyond the (already present) version record.
			E.init(A.doc);
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			expect(topIds(A)).toEqual([DEFAULT_SEED_ID]);
			expect(topIds(B)).toEqual([DEFAULT_SEED_ID]);
			expect(E.isInitialized(B.doc)).toBe(true);
		}
	},
	{
		id: 'SY03e',
		requirement: 'SY03',
		title: 'bootstrap then concurrent real inserts through the unified surface converge',
		run: () => {
			const set = createPeerTriple();
			const { A, B, C } = set;
			E.init(A.doc);
			E.init(B.doc);
			E.init(C.doc);
			// Concurrent first real inserts racing the bootstrap dedupe.
			ops.insertBlock(A, { parent: null, index: 0 }, { id: 'a1', type: 'paragraph' });
			ops.insertBlock(B, { parent: null, index: 1 }, { id: 'b1', type: 'paragraph' });
			ops.insertText(C, DEFAULT_SEED_ID, 0, 'typed into bootstrap');
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			// Exactly one bootstrap block, deterministic order everywhere.
			const a = topIds(A);
			expect(a.filter((i) => i === DEFAULT_SEED_ID)).toHaveLength(1);
			expect(new Set(a).size).toBe(3);
			expect(topIds(B)).toEqual(a);
			expect(topIds(C)).toEqual(a);
			expect(ops.blockText(A, DEFAULT_SEED_ID)).toBe('typed into bootstrap');
		}
	},

	// ── Replica-level op convergence through the unified surface ─────────
	{
		id: 'U06a',
		requirement: 'SY01',
		title: 'facade ops converge like the raw model (move + remote text edit)',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			ops.moveBlock(A, 'b1', { parent: 'b3', index: 0 });
			ops.insertText(B, 'b1', 5, '-EDIT');
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			expect(ops.positionOf(A, 'b1')).toEqual({ parent: 'b3', index: 0 });
			expect(ops.blockText(A, 'b1')).toBe('hello-EDIT world');
		}
	},
	{
		id: 'U06b',
		requirement: 'SY01',
		title: 'split + merge through the facade converge across replicas',
		run: () => {
			const set = createPeerPair(MODEL_BASE_SEED);
			const { A, B } = set;
			ops.splitBlock(A, 'b1', 5, 'b1-tail');
			ops.mergeBlocks(B, 'b2', 'b1');
			set.deliverAll();
			set.syncAll();
			assertConverged(set, ops);
			assertAllStructurallyValid(set, ops);
			// Concurrent split+merge compose (`merge.claim.anchor`, since
			// 0.1.0-next.26): b2's claim is anchored to the end of b1's text,
			// which the split moved to b1-tail, so b2 follows the tail — as
			// either serial order of the two gestures gives it.
			expect(ops.blockText(A, 'b1')).toBe('hello');
			expect(ops.blockText(A, 'b1-tail')).toBe(' worldsecond block');
			expect(ops.listBlockIds(A)).not.toContain('b2');
		}
	}
];
