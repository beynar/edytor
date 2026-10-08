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
 * and promotions and void shedding are fuzzed, and (ZW-11) a list, columns
 * of columns and a table, so the container rules are (`ROLES` in `doc-ops`).
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
	},
	// ZW-11: container kinds — a list of items (one with a paragraph child), columns of
	// columns, and a table island of rows of cells.
	{
		id: 'u1',
		type: 'unordered-list',
		content: [],
		children: [
			{
				id: 'u1a',
				type: 'list-item',
				content: [{ kind: 'text', text: 'item a' }],
				children: [{ id: 'u1a1', type: 'paragraph', content: [{ kind: 'text', text: 'under a' }] }]
			},
			{ id: 'u1b', type: 'list-item', content: [{ kind: 'text', text: 'item b' }] },
			{ id: 'u1c', type: 'list-item', content: [{ kind: 'text', text: 'item c' }] }
		]
	},
	{
		id: 'k1',
		type: 'columns',
		content: [],
		children: [
			{
				id: 'k1a',
				type: 'column',
				content: [],
				children: [{ id: 'k1a1', type: 'paragraph', content: [{ kind: 'text', text: 'left' }] }]
			},
			{
				id: 'k1b',
				type: 'column',
				content: [],
				children: [{ id: 'k1b1', type: 'paragraph', content: [{ kind: 'text', text: 'right' }] }]
			}
		]
	},
	{
		id: 't1',
		type: 'table',
		content: [],
		children: [
			{
				id: 't1r',
				type: 'row',
				content: [],
				children: [
					{ id: 't1c1', type: 'cell', content: [{ kind: 'text', text: 'one' }] },
					{ id: 't1c2', type: 'cell', content: [{ kind: 'text', text: 'two' }] }
				]
			}
		]
	}
]);

const cellSpec = (id: string, column: string, text: string) => ({
	id,
	type: 'tableCell',
	data: { column },
	content: [{ kind: 'text' as const, text }]
});

/**
 * The tables lane's seed (`table.*`): a paragraph, a table `{c1, c2}` of two
 * rows, a code block and a list, so table ops race generic ones.
 */
export const TABLES_BASE_SEED: SeedUpdate = modelSpecSeed([
	{ id: 'b1', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] },
	{
		id: 't1',
		type: 'table',
		data: { columns: [{ id: 'c1' }, { id: 'c2' }] },
		content: [],
		children: [
			{
				id: 't1r1',
				type: 'tableRow',
				content: [],
				children: [cellSpec('t1a', 'c1', 'one'), cellSpec('t1b', 'c2', 'two')]
			},
			{
				id: 't1r2',
				type: 'tableRow',
				content: [],
				children: [cellSpec('t1c', 'c1', 'three'), cellSpec('t1d', 'c2', 'four')]
			}
		]
	},
	{
		id: 'c1',
		type: 'code',
		content: [],
		children: [{ id: 'c1a', type: 'codeLine', content: [{ kind: 'text', text: 'let a' }] }]
	},
	{ id: 'b2', type: 'paragraph', content: [{ kind: 'text', text: 'after the table' }] }
]);

/** Empty document seed (concurrent-bootstrap scenarios). */
export const EMPTY_SEED: SeedUpdate = () => {};
