/** @jsxImportSource ./jsx */
import { describe, expect, it, vi } from 'vitest';
import { createOperationEdytor, createTestEdytor, stripAttribution } from './test.utils.js';
import { Text } from '$lib/text/text.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONDoc } from '$lib/utils/json.js';
import type { ProjectedDoc } from '$lib/crdt/index.js';

/**
 * U5 — scoped text refresh.
 *
 * `Text.refreshFromProject` (and the `segStart` display-offset read the
 * `insertAt`/`deleteAt`/`formatAt` mutation surface performs) used to go
 * through `edytor.projectedBlock` → `_projectedTree()` → `facade.project()`
 * + a whole-tree index walk — O(document) work on every `facade.version`
 * bump, i.e. per keystroke. The refresh now reads
 * `facade.contentItems(blockId)` (the maintained, transaction-aware
 * per-block surface) gated by `facade.isVisibleBlock(blockId)` (the
 * O(depth) projected-tree-membership oracle `projectedBlock → null`
 * provided).
 *
 * These tests pin the two halves of the change:
 *  - `facade.project()` is never called during ordinary text edits
 *    (instrumented on the live facade), while the committed-change mirror
 *    keeps applying incrementally (`flushMirror` — no full fallbacks).
 *  - The scoped read is a drop-in semantic replacement: read-your-writes
 *    mid-transaction, `_segOrd` mapping across inline atoms, marks, empty
 *    vs hidden/deleted blocks, and split/merge ownership aftermath.
 */

const paragraphDoc = (n: number): JSONDoc => ({
	children: Array.from({ length: n }, (_, i) => ({
		type: 'paragraph',
		id: `b${i}`,
		content: [{ text: `block ${i} content` }]
	}))
});

type Counters = { project: number; flushMirror: number; flushFullFallback: number };

/**
 * Test-visible counters: wraps `facade.project` (the tree-build the old
 * refresh forced per version bump) and `edytor.flushMirror` (the committed-
 * change mirror — its boolean return distinguishes the incremental
 * `applyMirrorChange` path from the full `reconcileChildren` fallback).
 */
const instrumentEdytor = (edytor: Edytor): Counters => {
	const counts: Counters = { project: 0, flushMirror: 0, flushFullFallback: 0 };
	const facade = edytor.facade;
	const project = facade.project;
	facade.project = (): ProjectedDoc => {
		counts.project++;
		return project();
	};
	const flushMirror = edytor.flushMirror;
	edytor.flushMirror = (): boolean => {
		counts.flushMirror++;
		const incremental = flushMirror();
		if (!incremental) counts.flushFullFallback++;
		return incremental;
	};
	return counts;
};

const textOf = (edytor: Edytor, blockIndex: number, partIndex = 0): Text => {
	const part = edytor.root!.children[blockIndex].content[partIndex];
	if (!(part instanceof Text)) {
		throw new Error(`part [${blockIndex}, ${partIndex}] is not a Text`);
	}
	return part;
};

describe('scoped text refresh — project() elimination', () => {
	for (const n of [100, 1000, 5000]) {
		it(`warmed single-paragraph edit at ${n} blocks → 0 project(), siblings untouched`, () => {
			const { edytor } = createOperationEdytor(<root />, { value: paragraphDoc(n) });
			const counts = instrumentEdytor(edytor);
			const text = textOf(edytor, 50);
			const sibling = textOf(edytor, 51);
			const siblingItems = sibling._items;
			const reconcileSpy = vi.spyOn(sibling.parent, 'reconcileContent');

			// Warm the projected tree at the current version (selection/
			// structure reads do this continuously in a live editor).
			edytor.projectedChildren(null);
			const before = { ...counts };

			edytor.transact(() => {
				text.insertAt(0, 'X');
			});

			expect(counts.project - before.project).toBe(0);
			expect(counts.flushMirror - before.flushMirror).toBe(1);
			expect(counts.flushFullFallback - before.flushFullFallback).toBe(0);
			expect(text.stringContent).toBe('Xblock 50 content');
			// The sibling wrapper was never reconciled — same `_items`
			// array instance, same derived string.
			expect(sibling._items).toBe(siblingItems);
			expect(sibling.stringContent).toBe('block 51 content');
			expect(reconcileSpy).not.toHaveBeenCalled();
		});
	}

	it('sequential keystrokes (insert/delete/format) never call project()', () => {
		const { edytor } = createOperationEdytor(
			(
				<root>
					<paragraph>Hello world</paragraph>
					<paragraph>sibling</paragraph>
				</root>
			) as any
		);
		const counts = instrumentEdytor(edytor);
		const text = textOf(edytor, 0);

		for (let i = 0; i < 5; i++) {
			edytor.transact(() => text.insertAt(i, 'x'));
		}
		for (let i = 0; i < 3; i++) {
			edytor.transact(() => text.deleteAt(0, 1));
		}
		edytor.transact(() => text.formatAt(0, 3, { bold: true }));

		expect(counts.project).toBe(0);
		expect(counts.flushFullFallback).toBe(0);
		expect(text.stringContent.slice(0, 3)).toBe('xxH');
		expect(text._items.some((item) => item.marks?.bold === true)).toBe(true);
	});

	it('multi-op transactions (setText = delete + N inserts) stay at 0 project()', () => {
		const { edytor } = createOperationEdytor(
			(
				<root>
					<paragraph>old</paragraph>
				</root>
			) as any
		);
		const counts = instrumentEdytor(edytor);
		const text = textOf(edytor, 0);

		edytor.transact(() => {
			text.deleteAt(0, text.length);
			text.insertAt(0, 'a');
			text.insertAt(1, 'b');
			text.insertAt(2, 'c');
		});

		expect(counts.project).toBe(0);
		expect(text.stringContent).toBe('abc');
	});
});

describe('scoped text refresh — correctness', () => {
	it('read-your-writes: write → refresh → write → refresh inside one transaction', () => {
		const { edytor } = createTestEdytor(
			(
				<root>
					<paragraph>Hello world</paragraph>
				</root>
			) as any
		);
		const text = textOf(edytor, 0);

		edytor.transact(() => {
			text.insertAt(5, ' brave');
			// The write above already ran the scoped refresh inside insertAt;
			// refresh again explicitly to prove the mid-transaction read.
			text.refreshFromProject();
			expect(text.stringContent).toBe('Hello brave world');
			text.deleteAt(5, 6);
			text.refreshFromProject();
			expect(text.stringContent).toBe('Hello world');
			text.formatAt(0, 5, { italic: true });
			text.refreshFromProject();
			expect(text._items[0]?.marks?.italic).toBe(true);
		});
		// Committed state agrees with what the mid-transaction reads saw
		// (U7 provenance stamps `attribution` on emitted items — strip it).
		expect(text.stringContent).toBe('Hello world');
		expect(stripAttribution(edytor.value.children?.[0]?.content ?? [])).toEqual([
			{ text: 'Hello', marks: { italic: true } },
			{ text: ' world' }
		]);
	});

	it('keeps _segOrd mapping across inline atoms — writes land in the right segment', () => {
		const { edytor } = createTestEdytor(
			(
				<root>
					<paragraph>
						Hello<mention></mention>world
					</paragraph>
				</root>
			) as any
		);
		const block = edytor.root!.children[0];
		const [first, atom, second] = block.content;
		expect(first).toBeInstanceOf(Text);
		expect(atom).toBeInstanceOf(InlineBlock);
		expect(second).toBeInstanceOf(Text);
		const firstText = first as Text;
		const secondText = second as Text;
		expect(secondText._segOrd).toBe(1);
		// Scoped segStart agrees with the full-tree partOffsetOf oracle.
		expect(secondText.segStart).toBe(block.partOffsetOf(secondText));
		expect(secondText.segStart).toBe(6); // 'Hello' + 1 atom

		const firstItems = firstText._items;
		edytor.transact(() => {
			secondText.insertAt(0, '!');
		});
		expect(secondText.stringContent).toBe('!world');
		expect(firstText.stringContent).toBe('Hello');
		// Same-block sibling segments are re-bound by the commit's
		// `reconcileContent` (fresh items array, same content) — the scoped
		// refresh keeps identity only for OTHER blocks' wrappers.
		expect(stripAttribution(firstText._items)).toEqual(stripAttribution(firstItems));
		expect(secondText._segOrd).toBe(1);

		// Deleting inside the FIRST segment leaves the second's offset
		// mapped through the live projection, not the stale mirror.
		edytor.transact(() => {
			firstText.deleteAt(0, 2);
		});
		expect(firstText.stringContent).toBe('llo');
		expect(secondText.segStart).toBe(4); // 'llo' + 1 atom
		edytor.transact(() => {
			secondText.insertAt(0, '?');
		});
		expect(secondText.stringContent).toBe('?!world');
	});

	it('marks survive the scoped read (insert + format round-trip)', () => {
		const { edytor } = createTestEdytor(
			(
				<root>
					<paragraph>
						Hello <bold>world</bold>
					</paragraph>
				</root>
			) as any
		);
		const text = textOf(edytor, 0);
		expect(stripAttribution(text._items)).toEqual([
			{ text: 'Hello ' },
			{ text: 'world', marks: { bold: true } }
		]);

		edytor.transact(() => {
			text.insertAt(6, 'big ', { bold: true });
		});
		// Attribution provenance splits same-mark runs at authorship
		// boundaries — `stripAttribution` re-merges them for comparison.
		expect(stripAttribution(text._items)).toEqual([
			{ text: 'Hello ' },
			{ text: 'big world', marks: { bold: true } }
		]);

		edytor.transact(() => {
			text.formatAt(0, 5, { underline: true });
		});
		expect(text._items[0]?.marks).toEqual({ underline: true });
		expect(text._items.at(-1)?.marks).toEqual({ bold: true });
	});

	it('empty block refreshes to an empty segment — [] ≠ absent', () => {
		const { edytor } = createTestEdytor(
			(
				<root>
					<paragraph>full</paragraph>
					<paragraph></paragraph>
				</root>
			) as any
		);
		const text = textOf(edytor, 1);
		expect(text.stringContent).toBe('');
		expect(edytor.facade.isVisibleBlock(text.parent._blockId!)).toBe(true);
		expect(edytor.facade.contentItems(text.parent._blockId!)).toEqual([]);

		text.refreshFromProject();
		expect(text._items).toEqual([]);
		expect(text.isEmpty).toBe(true);

		// A write into the empty block refreshes through the same path.
		edytor.transact(() => {
			text.insertAt(0, 'now full');
		});
		expect(text.stringContent).toBe('now full');
	});

	it('hidden/deleted block mid-edit keeps last-known items (projectedBlock-null parity)', () => {
		const { edytor } = createTestEdytor(
			(
				<root>
					<paragraph>one</paragraph>
					<paragraph>two</paragraph>
				</root>
			) as any
		);
		const block = edytor.root!.children[1];
		const text = textOf(edytor, 1);
		const itemsBefore = text._items;

		edytor.transact(() => {
			edytor.facade.deleteBlock(block._blockId!);
			// Mid-transaction the block is already hidden — `contentItems`
			// alone would emit `[]` like an empty block; the visibility gate
			// keeps the stale items, exactly as `projectedBlock → null` did.
			expect(edytor.facade.isVisibleBlock(block._blockId!)).toBe(false);
			expect(edytor.facade.contentItems(block._blockId!)).toEqual([]);
			text.refreshFromProject();
			expect(text._items).toBe(itemsBefore);
			expect(text.stringContent).toBe('two');
		});

		// The commit's mirror reconcile then kills the wrapper for real.
		expect(text._live).toBe(false);
		expect(edytor.value.children?.map((b) => b.content?.[0])).toEqual([{ text: 'one' }]);
	});

	it('merged-away block mid-edit is hidden, not emptied', () => {
		const { edytor } = createTestEdytor(
			(
				<root>
					<paragraph>one</paragraph>
					<paragraph>two</paragraph>
				</root>
			) as any
		);
		const first = edytor.root!.children[0];
		const second = edytor.root!.children[1];
		const secondText = textOf(edytor, 1);
		const itemsBefore = secondText._items;

		edytor.transact(() => {
			// Engine primitive: second's content claims into first — second
			// is live (not del-flagged) but merged away ⇒ invisible.
			edytor.facade.mergeBlocks(second._blockId!, first._blockId!);
			expect(edytor.facade.hasBlock(second._blockId!)).toBe(true);
			expect(edytor.facade.isVisibleBlock(second._blockId!)).toBe(false);
			secondText.refreshFromProject();
			expect(secondText._items).toBe(itemsBefore);
		});
	});

	it('split/merge aftermath — refreshed segments show the atoms their new owner displays', () => {
		const { edytor } = createTestEdytor(
			(
				<root>
					<paragraph>Hello world</paragraph>
					<paragraph>next</paragraph>
				</root>
			) as any
		);
		const block = edytor.root!.children[0];
		const text = textOf(edytor, 0);

		// Split at offset 6 — 'world' moves to a fresh sibling whose backing
		// slice claims the tail (no atom copies; ownership moves).
		const sibling = block.splitBlock({ index: 6, text });
		expect(sibling).toBeTruthy();
		const siblingText = sibling!.content[0] as Text;
		siblingText.refreshFromProject();
		expect(siblingText.stringContent).toBe('world');
		text.refreshFromProject();
		expect(text.stringContent).toBe('Hello ');
		// The sibling's segment is bound to the NEW block id.
		expect(siblingText.parent).toBe(sibling);
		expect(siblingText._live).toBe(true);

		// Merge the sibling back — the refreshed segment of the surviving
		// block shows the reclaimed atoms under the original owner.
		const merged = sibling!.mergeBlockBackward();
		expect(merged).toBeTruthy();
		const mergedText = merged!.content[0] as Text;
		mergedText.refreshFromProject();
		expect(mergedText.stringContent).toBe('Hello world');
	});

	it('isVisibleBlock agrees with positionOf across every state', () => {
		const { edytor } = createOperationEdytor(
			(
				<root>
					<paragraph>one</paragraph>
					<ordered-list>
						<list-item>nested</list-item>
					</ordered-list>
					<paragraph>three</paragraph>
				</root>
			) as any
		);
		const facade = edytor.facade;
		const check = () => {
			for (const id of facade.listBlockIds()) {
				expect(facade.isVisibleBlock(id), id).toBe(facade.positionOf(id) !== null);
			}
			// Absent ids agree too.
			expect(facade.isVisibleBlock('nope')).toBe(facade.positionOf('nope') !== null);
		};
		check();

		const third = edytor.root!.children[2];
		// move → placement churn
		third.moveBlock({ path: [0] });
		check();
		// delete → hidden
		edytor.transact(() => {
			facade.deleteBlock(edytor.root!.children[0]._blockId!);
			check();
		});
		check();
	});
});
