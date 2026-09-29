/**
 * Shared seed documents for scenarios. A seed is a function that writes ONE
 * document; `createPeerSet` serializes it once and replicates by update.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import type { SeedUpdate } from '../harness/peer-set.js';
import { buildBlock } from '../harness/ops/raw-node-ops.js';
import type { BlockSpec } from '../harness/ops/crdt-ops.js';

const M = bindModel(Y);

/** Seed builder: top-level blocks appended to the root in order. */
export const specSeed = (blocks: BlockSpec[]): SeedUpdate => {
	return (doc) => {
		const root = doc.get('content');
		for (const spec of blocks) {
			root.insert(root.length, [buildBlock(spec)]);
		}
	};
};

/**
 * Same as {@link specSeed} but against the U03 placement schema: every block
 * is a registry entry with an atomic placement record. Used for all
 * `ModelOps` scenarios and the model corpus.
 */
export const modelSpecSeed = (blocks: BlockSpec[]): SeedUpdate => {
	return (doc) => {
		doc.transact(() => {
			// Bulk insert (U7): identical rank chain to N sequential
			// insertBlock calls, one sibling read for the batch.
			M.insertBlocks(doc, { parent: null, index: Number.MAX_SAFE_INTEGER }, blocks);
		});
	};
};

/** Canonical three-block document used by most scenarios. */
export const BASE_SEED: SeedUpdate = specSeed([
	{
		id: 'b1',
		type: 'paragraph',
		content: [{ kind: 'text', text: 'hello world' }]
	},
	{
		id: 'b2',
		type: 'paragraph',
		content: [
			{ kind: 'text', text: 'second', marks: { bold: true } },
			{ kind: 'text', text: ' block' }
		]
	},
	{
		id: 'b3',
		type: 'list',
		content: [{ kind: 'text', text: 'parent' }],
		children: [
			{ id: 'b3a', type: 'paragraph', content: [{ kind: 'text', text: 'child a' }] },
			{ id: 'b3b', type: 'paragraph', content: [{ kind: 'text', text: 'child b' }] }
		]
	}
]);

/** {@link BASE_SEED} in placement-model schema. */
export const MODEL_BASE_SEED: SeedUpdate = modelSpecSeed([
	{
		id: 'b1',
		type: 'paragraph',
		content: [{ kind: 'text', text: 'hello world' }]
	},
	{
		id: 'b2',
		type: 'paragraph',
		content: [
			{ kind: 'text', text: 'second', marks: { bold: true } },
			{ kind: 'text', text: ' block' }
		]
	},
	{
		id: 'b3',
		type: 'list',
		content: [{ kind: 'text', text: 'parent' }],
		children: [
			{ id: 'b3a', type: 'paragraph', content: [{ kind: 'text', text: 'child a' }] },
			{ id: 'b3b', type: 'paragraph', content: [{ kind: 'text', text: 'child b' }] }
		]
	}
]);

/**
 * The roles lane's seed (RW-01): {@link MODEL_BASE_SEED}'s blocks plus a
 * code island with its lines and a void divider, so island merges, deletes
 * and promotions and void shedding are fuzzed (`ROLES` in `doc-ops`).
 */
export const ROLES_BASE_SEED: SeedUpdate = modelSpecSeed([
	{ id: 'b1', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] },
	{
		id: 'c1',
		type: 'code',
		content: [],
		children: [
			{ id: 'c1a', type: 'codeLine', content: [{ kind: 'text', text: 'let a' }] },
			{ id: 'c1b', type: 'codeLine', content: [{ kind: 'text', text: 'let b' }] }
		]
	},
	{ id: 'd1', type: 'divider', content: [] },
	{
		id: 'b3',
		type: 'list',
		content: [{ kind: 'text', text: 'parent' }],
		children: [{ id: 'b3a', type: 'paragraph', content: [{ kind: 'text', text: 'child a' }] }]
	}
]);

/** Empty document seed (concurrent-bootstrap scenarios). */
export const EMPTY_SEED: SeedUpdate = () => {};
