/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint S5 rows (dom lane): one relative-move command (R5, R7,
 * L51, decision D-5).
 *
 * - F-P6 — `A, B{B1}, C`; move A down via arrow-move (Mod+Down), via the
 *   handle's Alt+Down and via a consumer call: `B{B1}, A, C` on every path
 *   ("move down" = after the next sibling, never into its children).
 * - The same meaning for up (before the previous sibling, never into its
 *   children), at a parent's ends (past the first/last sibling the block
 *   leaves its parent: before/after it), for in (last child of the previous
 *   sibling) and out (after the parent, the siblings after it following as
 *   its children — the outdent, UW-23), for a selected group of siblings.
 * - Capability is the same predicate: `canMoveBlocks` answers exactly when
 *   `moveBlocks` moves.
 * - A move vetoed by an extension is a cancel on every path; a move is one
 *   undo step (R7: structural commands cut before they write).
 *
 * Expected values come from the plan rows and D-5, never from running the code.
 */
import { describe, expect, it } from 'vitest';
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { RenderedNode } from '../../jsx/types.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

/** Red on the reference; green since S5. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

type Direction = 'up' | 'down' | 'in' | 'out';
type Path = 'arrow-move' | 'handle' | 'consumer';

const vetoMoves: Plugin = () => ({
	onBeforeOperation: ({ operation, prevent }) => {
		if (/^(moveBlocks?|nestBlock|unNestBlock)$/.test(operation)) prevent();
	}
});

const render = (jsx: RenderedNode, extra: Plugin[] = []) =>
	renderDomEdytor(jsx, {
		plugins: [richTextPlugin, mentionPlugin, arrowMovePlugin, blockHandlesPlugin, ...extra]
	});

/** `A, B{B1}, C`: each block's own text, its children in braces. */
const shape = (block: Block): string =>
	(block.firstText?.stringContent ?? '') +
	(block.children.length ? `{${block.children.map(shape).join(', ')}}` : '');
const tree = (edytor: Edytor) => edytor.root!.children.map(shape).join(', ');

const find = (edytor: Edytor, text: string): Block => {
	const walk = (blocks: Block[]): Block | undefined => {
		for (const block of blocks) {
			if (block.firstText?.stringContent === text) return block;
			const hit = walk(block.children);
			if (hit) return hit;
		}
	};
	const block = walk(edytor.root!.children);
	if (!block) throw new Error(`no block ${text}`);
	return block;
};

const ARROWS = { up: 'ArrowUp', down: 'ArrowDown', in: 'ArrowRight', out: 'ArrowLeft' } as const;

/** Move `texts` one step in `direction` through one of the three entry points. */
const move = async (edytor: Edytor, path: Path, direction: Direction, ...texts: string[]) => {
	const blocks = texts.map((text) => find(edytor, text));
	if (path === 'arrow-move') {
		edytor.selection.selectBlocks(...blocks);
		const key = ARROWS[direction];
		await dispatchDomKeyDown(document, { key, code: key, metaKey: true });
	} else if (path === 'handle') {
		const handle = document.querySelector<HTMLElement>(
			`[data-testid="block-handle"][data-block-id="${blocks[0].id}"]`
		)!;
		const key = ARROWS[direction];
		await dispatchDomKeyDown(handle, { key, code: key, altKey: true });
	} else {
		edytor.moveBlocks({ blocks, direction });
		await flushDomUpdates();
	}
};

const selected = (edytor: Edytor) =>
	Array.from(edytor.selection.selectedBlocks, (block) => block.firstText?.stringContent);

describe('F-P6 — "move down" is after the next sibling, never into its children (D-5)', () => {
	const doc = (
		<root>
			<paragraph>A</paragraph>
			<paragraph>
				B<paragraph>B1</paragraph>
			</paragraph>
			<paragraph>C</paragraph>
		</root>
	);

	row('arrow-move (Mod+Down on the selected block)', async () => {
		const { edytor } = await render(doc);
		await move(edytor, 'arrow-move', 'down', 'A');
		expect(tree(edytor)).toBe('B{B1}, A, C');
		expect(selected(edytor)).toEqual(['A']);
	});

	pin("the handle's Alt+Down", async () => {
		const { edytor } = await render(doc);
		await move(edytor, 'handle', 'down', 'A');
		expect(tree(edytor)).toBe('B{B1}, A, C');
		expect(selected(edytor)).toEqual(['A']);
	});

	row('a consumer call (edytor.moveBlocks with a direction)', async () => {
		const { edytor } = await render(doc);
		await move(edytor, 'consumer', 'down', 'A');
		expect(tree(edytor)).toBe('B{B1}, A, C');
	});
});

describe('the same relative meaning on every path', () => {
	const nested = (
		<root>
			<paragraph>
				A<paragraph>A1</paragraph>
				<paragraph>A2</paragraph>
			</paragraph>
			<paragraph>B</paragraph>
		</root>
	);

	// Up: before the previous sibling, never into its children.
	row('arrow-move up: B → before A, not into A', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'arrow-move', 'up', 'B');
		expect(tree(edytor)).toBe('B, A{A1, A2}');
	});
	pin('handle up: B → before A, not into A', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'handle', 'up', 'B');
		expect(tree(edytor)).toBe('B, A{A1, A2}');
	});
	row('consumer up: B → before A, not into A', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'consumer', 'up', 'B');
		expect(tree(edytor)).toBe('B, A{A1, A2}');
	});

	// Past the last sibling: after the parent.
	pin('arrow-move down past the last child: after the parent', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'arrow-move', 'down', 'A2');
		expect(tree(edytor)).toBe('A{A1}, A2, B');
	});
	row('handle down past the last child: after the parent', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'handle', 'down', 'A2');
		expect(tree(edytor)).toBe('A{A1}, A2, B');
	});
	row('consumer down past the last child: after the parent', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'consumer', 'down', 'A2');
		expect(tree(edytor)).toBe('A{A1}, A2, B');
	});

	// Past the first sibling: before the parent.
	pin('arrow-move up past the first child: before the parent', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'arrow-move', 'up', 'A1');
		expect(tree(edytor)).toBe('A1, A{A2}, B');
	});
	row('handle up past the first child: before the parent', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'handle', 'up', 'A1');
		expect(tree(edytor)).toBe('A1, A{A2}, B');
	});

	// Inside a parent: past the next sibling only.
	pin('handle down between siblings stays in the parent', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'handle', 'down', 'A1');
		expect(tree(edytor)).toBe('A{A2, A1}, B');
	});

	// In: the last child of the previous sibling. Out: after the parent.
	pin('handle in: B → last child of A', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'handle', 'in', 'B');
		expect(tree(edytor)).toBe('A{A1, A2, B}');
	});
	row('consumer in: B → last child of A', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'consumer', 'in', 'B');
		expect(tree(edytor)).toBe('A{A1, A2, B}');
	});
	row('handle out: A1 → after A, A2 follows as its child (UW-23)', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'handle', 'out', 'A1');
		expect(tree(edytor)).toBe('A, A1{A2}, B');
	});
	row('consumer out: A1 → after A, A2 follows as its child (UW-23)', async () => {
		const { edytor } = await render(nested);
		await move(edytor, 'consumer', 'out', 'A1');
		expect(tree(edytor)).toBe('A, A1{A2}, B');
	});

	// A selected group of siblings moves as one.
	pin('arrow-move down with two selected siblings', async () => {
		const { edytor } = await render(
			<root>
				<paragraph>X</paragraph>
				<paragraph>A</paragraph>
				<paragraph>B</paragraph>
				<paragraph>Y</paragraph>
			</root>
		);
		await move(edytor, 'arrow-move', 'down', 'A', 'B');
		expect(tree(edytor)).toBe('X, Y, A, B');
		expect(selected(edytor)).toEqual(['A', 'B']);
	});
	row('arrow-move up with two selected siblings', async () => {
		const { edytor } = await render(
			<root>
				<paragraph>X</paragraph>
				<paragraph>A</paragraph>
				<paragraph>B</paragraph>
				<paragraph>Y</paragraph>
			</root>
		);
		await move(edytor, 'arrow-move', 'up', 'A', 'B');
		expect(tree(edytor)).toBe('A, B, X, Y');
		expect(selected(edytor)).toEqual(['A', 'B']);
	});
});

describe('capability: canMoveBlocks answers exactly when moveBlocks moves', () => {
	row('every block × every direction on A{A1, A2}, B', async () => {
		const expected: Record<string, Record<Direction, boolean>> = {
			A: { up: false, down: true, in: false, out: false },
			A1: { up: true, down: true, in: false, out: true },
			A2: { up: true, down: true, in: true, out: true },
			B: { up: true, down: false, in: true, out: false }
		};
		const { edytor } = await render(
			<root>
				<paragraph>
					A<paragraph>A1</paragraph>
					<paragraph>A2</paragraph>
				</paragraph>
				<paragraph>B</paragraph>
			</root>
		);
		const answers = Object.fromEntries(
			Object.keys(expected).map((text) => [
				text,
				Object.fromEntries(
					(['up', 'down', 'in', 'out'] as const).map((direction) => [
						direction,
						edytor.canMoveBlocks({ blocks: [find(edytor, text)], direction })
					])
				)
			])
		);
		expect(answers).toEqual(expected);
	});
});

describe('a vetoed move is a cancel; a move is one undo step', () => {
	const doc = (
		<root>
			<paragraph>A</paragraph>
			<paragraph>
				B<paragraph>B1</paragraph>
			</paragraph>
			<paragraph>C</paragraph>
		</root>
	);

	for (const path of ['arrow-move', 'handle', 'consumer'] as const) {
		pin(`${path}: an extension veto leaves the document unchanged`, async () => {
			const { edytor } = await render(doc, [vetoMoves]);
			await move(edytor, path, 'down', 'A');
			expect(tree(edytor)).toBe('A, B{B1}, C');
		});
	}

	row('typing, then a handle move: undo reverts the move only', async () => {
		const { edytor, editor } = await render(
			<root>
				<paragraph>A</paragraph>
				<paragraph>
					B<paragraph>B1</paragraph>
				</paragraph>
				<paragraph>C|</paragraph>
			</root>
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		expect(tree(edytor)).toBe('A, B{B1}, Cx');
		await move(edytor, 'handle', 'down', 'A');
		expect(tree(edytor)).toBe('B{B1}, A, Cx');
		edytor.historyUndo();
		await flushDomUpdates();
		expect(tree(edytor)).toBe('A, B{B1}, Cx');
	});
});
