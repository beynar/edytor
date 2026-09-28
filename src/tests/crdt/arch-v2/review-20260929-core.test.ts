/**
 * Independent review at 5e21dad. Expectations are the user's fixed contracts.
 * Kept as permanent regression rows for `del.blocks.promote` and
 * `hist.undo.withdraw` (docs/editor-delete-contract.md); the contracts' own
 * rows are in `contracts-preserve.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { replica, seedUpdate, quiesce, reloadCanonical, type Replica } from './p1-harness.js';

const opened: Replica[] = [];
afterEach(() => {
	for (const peer of opened.splice(0)) peer.destroy();
});

function peers(seed: Parameters<typeof seedUpdate>[0], ids = [20, 30]) {
	const bytes = seedUpdate(seed);
	const pair = ids.map((id, i) => replica(`review-${i}`, bytes, id));
	opened.push(...pair);
	return pair;
}

function expectReplicas(pair: Replica[], expected: string) {
	quiesce(pair);
	for (const peer of pair) {
		expect(peer.problems).toEqual([]);
		expect(peer.pending()).toBe(false);
		expect(peer.tree()).toBe(expected);
		expect(reloadCanonical(peer)).toBe(peer.canonical());
	}
}

describe('fixed user requirements: preserve content the user did not remove', () => {
	it('deleting only selected parent promotes its unselected children in order', () => {
		const [a, b] = peers([
			{
				id: 'P',
				text: 'parent',
				children: [
					{ id: 'C', text: 'child', children: [{ id: 'G', text: 'grandchild' }] },
					{ id: 'D', text: 'second' }
				]
			},
			{ id: 'Z', text: 'after' }
		]);
		expect(a.ed.deleteBlocks(['P']).status).toBe('applied');
		expectReplicas([a, b], 'C:"child"[G:"grandchild"] D:"second" Z:"after"');
	});

	it('nested selected parent promotes children to its vacated nested position', () => {
		const [a, b] = peers([
			{
				id: 'R',
				text: 'root',
				children: [
					{ id: 'L', text: 'left' },
					{ id: 'P', text: 'parent', children: [{ id: 'C', text: 'child' }] },
					{ id: 'Z', text: 'right' }
				]
			}
		]);
		expect(a.ed.deleteBlocks(['P']).status).toBe('applied');
		expectReplicas([a, b], 'R:"root"[L:"left",C:"child",Z:"right"]');
	});

	it('explicit keepChildren remains a working control', () => {
		const [a, b] = peers([
			{ id: 'P', text: 'parent', children: [{ id: 'C', text: 'child' }] },
			{ id: 'Z', text: 'after' }
		]);
		expect(a.ed.deleteBlock('P', { keepChildren: true }).status).toBe('applied');
		expectReplicas([a, b], 'C:"child" Z:"after"');
	});

	it('undoing empty block creation preserves a foreign text contribution in the same shell', () => {
		const [a, b] = peers([{ id: 'P', text: 'abc' }]);
		b.receiveAll(
			a.capture(() => a.ed.insertBlock({ parent: null, index: 1 }, { id: 'N', type: 'paragraph' }))
		);
		a.receiveAll(b.capture(() => b.ed.insertText('N', 0, 'foreign')));
		expect(a.undo()).not.toBeNull();
		expectReplicas([a, b], 'P:"abc" N:"foreign"');
	});

	it('explicit deletion still wins over an unseen insertion into the deleted block', () => {
		const [a, b] = peers([
			{ id: 'P', text: 'abc' },
			{ id: 'Z', text: 'after' }
		]);
		expect(a.ed.deleteBlocks(['P']).status).toBe('applied');
		expect(b.ed.insertText('P', 1, 'foreign').status).toBe('applied');
		expectReplicas([a, b], 'Z:"after"');
	});

	it('each author undoing the same text deletion restores one character, never two', () => {
		const [a, b] = peers([{ id: 'P', text: 'abc' }]);
		expect(a.ed.deleteText('P', 1, 1).status).toBe('applied');
		expect(b.ed.deleteText('P', 1, 1).status).toBe('applied');
		quiesce([a, b]);
		expect(a.ed.blockText('P')).toBe('ac');
		a.undo();
		quiesce([a, b]);
		expect.soft(a.ed.blockText('P'), 'other author deletion remains active').toBe('ac');
		b.undo();
		quiesce([a, b]);
		expect.soft(a.ed.blockText('P'), 'both authors have undone; restore exactly once').toBe('abc');
		expect.soft(b.ed.blockText('P')).toBe('abc');
	});
});

describe('exact structural and offline continuation probes', () => {
	for (const ids of [
		[20, 30],
		[30, 20]
	]) {
		it(`offline split versus join keeps the tail editable (${ids.join('/')})`, () => {
			const [a, b] = peers(
				[
					{ id: 'A', text: 'ab' },
					{ id: 'B', text: 'c' }
				],
				ids
			);
			expect(a.ed.splitBlock('A', 1, 'T').status).toBe('applied');
			expect(b.ed.mergeBlocks('A', 'B').status).toBe('applied');
			expectReplicas([a, b], 'T:"b" B:"ca"');
			expect(a.ed.insertText('T', 0, 'X').status).toBe('applied');
			expectReplicas([a, b], 'T:"Xb" B:"ca"');
		});
	}

	it('repeated moves use the authored current order', () => {
		const [a, b] = peers([
			{ id: 'A', text: 'a' },
			{ id: 'B', text: 'b' },
			{ id: 'C', text: 'c' }
		]);
		expect(a.ed.moveBlock('A', { parent: null, index: 2 }).status).toBe('applied');
		expect(a.tree()).toBe('B:"b" C:"c" A:"a"');
		expect(a.ed.moveBlock('C', { parent: null, index: 0 }).status).toBe('applied');
		expect(a.tree()).toBe('C:"c" B:"b" A:"a"');
		expect(a.ed.moveBlock('A', { parent: null, index: 0 }).status).toBe('applied');
		expectReplicas([a, b], 'A:"a" C:"c" B:"b"');
	});

	it('split after move follows the moved head and undo restores the moved paragraph', () => {
		const [a, b] = peers([
			{ id: 'A', text: 'ab' },
			{ id: 'B', text: 'cd' },
			{ id: 'C', text: 'ef' }
		]);
		expect(a.ed.moveBlock('A', { parent: null, index: 2 }).status).toBe('applied');
		expect(a.ed.splitBlock('A', 1, 'T').status).toBe('applied');
		expectReplicas([a, b], 'B:"cd" C:"ef" A:"a" T:"b"');
		a.undo();
		expectReplicas([a, b], 'B:"cd" C:"ef" A:"ab"');
	});

	it('split at the old join boundary and delayed source typing preserve exact text and ordering', () => {
		const [a, b] = peers([
			{ id: 'A', text: 'ab' },
			{ id: 'B', text: 'cd' },
			{ id: 'Z', text: 'ef' }
		]);
		expect(a.ed.mergeBlocks('B', 'A').status).toBe('applied');
		expect(a.ed.splitBlock('A', 2, 'T').status).toBe('applied');
		expect(b.ed.insertText('B', 1, 'X').status).toBe('applied');
		expectReplicas([a, b], 'A:"ab" T:"cXd" Z:"ef"');
	});
});
