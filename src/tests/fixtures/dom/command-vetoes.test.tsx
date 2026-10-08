/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint S2 rows (dom lane): split, merge, the collapsed delete
 * ladders, nest/unnest, convert and atom removal are commands over prepared
 * plans (R6, R7, D-10, FP-6). Each user action is ONE plan composed from
 * document prepares, so a veto on any of its steps refuses the whole command
 * before any write.
 *
 * - F-P16 (a) the grouped-move retarget lands; (b) the code plugin's
 *   forward-delete rule replaces Delete in an empty paragraph before a code
 *   block; (c) an extension refusing any command whose effect removes `c`
 *   refuses a range delete spanning `c` whole, zero bytes.
 * - F-M3 — markdown shortcuts on, an extension refuses conversion: typing `#`
 *   then space in an empty paragraph reads `"# "`.
 * - One veto-midway row per multi-operation command (the reference applies
 *   the steps before the vetoed one): the slash command (trigger removal +
 *   conversion), Enter lifting content above children, the divider insertion
 *   inside text, merges that unnest children (Backspace and Delete), nest and
 *   unnest. Each proves zero bytes and an unchanged document.
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import {
	canonicalTree,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference; green since S2. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

/** The label a hook call is recorded under: its block's text. */
const labelOf = (block: unknown) =>
	(block as { firstText?: { stringContent: string } } | undefined)?.firstText?.stringContent ?? '';

/** A vetoing extension: refuses `operation` on the block showing `text`. */
const vetoing =
	(operation: string, text?: string): Plugin =>
	() => ({
		onBeforeOperation: (change) => {
			if (change.operation === operation && (text === undefined || labelOf(change.block) === text))
				change.prevent();
		}
	});

const plugins = (...extra: Plugin[]) => [richTextPlugin, mentionPlugin, ...extra];

/** Bytes written from now on. */
const track = (edytor: Edytor) => {
	let bytes = 0;
	edytor.doc.on('update', (update: Uint8Array) => (bytes += update.byteLength));
	return () => bytes;
};

const textOf = (edytor: Edytor, path: number[]) => {
	let block = edytor.root!;
	for (const index of path) block = block.children[index]!;
	return block.firstText!;
};

/** The document's shape as `type:text` per block, children indented by `>`. */
const shape = (edytor: Edytor) => {
	const out: string[] = [];
	const walk = (blocks: ReturnType<typeof canonicalTree>, depth: number) => {
		for (const block of blocks) {
			const text = (block.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
			out.push(`${'>'.repeat(depth)}${block.type}:${text}`);
			walk(block.children ?? [], depth + 1);
		}
	};
	walk(canonicalTree(edytor), 0);
	return out;
};

/** Run `act`: the document ends as it started, zero bytes written, no undo step added. */
const expectRefusedWhole = async (edytor: Edytor, act: () => Promise<unknown>) => {
	const before = shape(edytor);
	const steps = edytor.undoManager.undoStack.length;
	const bytes = track(edytor);
	await act();
	await flushDomUpdates();
	expect(shape(edytor)).toEqual(before);
	expect(bytes()).toBe(0);
	expect(edytor.undoManager.undoStack.length).toBe(steps);
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('F-P16 — extensions keep their interception contract (FP-6)', () => {
	pin('(a) a hook retargets a grouped move: the replacement lands', async () => {
		const retarget: Plugin = () => ({
			onBeforeOperation: (change) => {
				if (change.operation === 'moveBlocks') return { ...change.payload, path: [3] };
			}
		});
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>one</paragraph>
				<paragraph>two</paragraph>
				<paragraph>three</paragraph>
				<paragraph>four</paragraph>
			</root>,
			{ plugins: plugins(retarget), autoSelectFixture: false }
		);
		const [one, two] = edytor.root!.children;
		one!.moveBlocks({ blocks: [one!, two!], path: [1] });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([
			'paragraph:three',
			'paragraph:four',
			'paragraph:one',
			'paragraph:two'
		]);
	});

	pin('(b) Delete in an empty paragraph before a code block removes the paragraph', async () => {
		const { edytor, editor } = await renderDomEdytor(<root />, {
			plugins: plugins(codePlugin),
			value: {
				children: [
					{ type: 'paragraph', content: [{ text: 'a' }] },
					{ type: 'paragraph', content: [{ text: '|' }] },
					{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'x' }] }] }
				]
			}
		});
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:a', 'code:', '>codeLine:x']);
	});

	row('(c) refusing any command whose effect removes c refuses a range delete', async () => {
		let cId = '';
		const protecting: Plugin = () => ({
			onBeforeOperation: (change) => {
				if (change.effect?.removes.includes(cId)) change.prevent();
			}
		});
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>aa</paragraph>
				<paragraph>bb</paragraph>
				<paragraph>cc</paragraph>
				<paragraph>dd</paragraph>
			</root>,
			{ plugins: plugins(protecting), autoSelectFixture: false }
		);
		cId = edytor.root!.children[2]!.id;
		await setNativeSelection(edytor, textOf(edytor, [0]), 1, textOf(edytor, [3]), 1);
		await expectRefusedWhole(edytor, () =>
			dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' })
		);
	});
});

describe('F-M3 — a veto inside a composite', () => {
	row('markdown "# " under a refused conversion reads "# "', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: plugins(markdownShortcutsPlugin, vetoing('setBlock')) }
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '#' });
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: ' ' });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:# ']);
	});

	pin('without the veto, "# " converts to a heading with the caret at its start', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: plugins(markdownShortcutsPlugin) }
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '#' });
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: ' ' });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['heading:']);
		const { startText, yStart, isCollapsed } = edytor.selection.state;
		expect(startText).toBe(textOf(edytor, [0]));
		expect([yStart, isCollapsed]).toEqual([0, true]);
	});
});

describe('a veto on any step refuses the whole command (zero writes)', () => {
	row('slash command: refusing the conversion keeps the trigger text', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: plugins(slashMenuPlugin, vetoing('setBlock')) }
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '/' });
		await dispatchDomKeyDown(document, { key: 'ArrowDown', code: 'ArrowDown' });
		await expectRefusedWhole(edytor, () =>
			dispatchDomKeyDown(document, { key: 'Enter', code: 'Enter' })
		);
		expect(shape(edytor)).toEqual(['paragraph:/']);
	});

	row('Enter lifting content above children: refusing the split', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>
					ab|
					<paragraph>child</paragraph>
				</paragraph>
			</root>,
			{ plugins: plugins(vetoing('splitBlock', 'ab')) }
		);
		await expectRefusedWhole(edytor, () =>
			dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' })
		);
	});

	pin('Enter lifting content above children (no veto)', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>
					ab|
					<paragraph>child</paragraph>
				</paragraph>
			</root>,
			{ plugins: plugins() }
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		expect(shape(edytor)).toEqual(['paragraph:ab', 'paragraph:', '>paragraph:child']);
		expect(edytor.selection.state.startText).toBe(textOf(edytor, [1]));
	});

	row('divider inside text: refusing the divider insertion refuses the split', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|cd</paragraph>
			</root>,
			{ plugins: plugins(vetoing('addChildBlocks')) }
		);
		await expectRefusedWhole(edytor, () =>
			dispatchDomBeforeInput(editor, { inputType: 'insertHorizontalRule' })
		);
	});

	pin('divider inside text (no veto)', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|cd</paragraph>
			</root>,
			{ plugins: plugins() }
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertHorizontalRule' });
		expect(shape(edytor)).toEqual(['paragraph:ab', 'divider:', 'paragraph:cd']);
		expect(edytor.selection.state.startText).toBe(textOf(edytor, [2]));
	});

	pin('divider in an empty block converts it, a fresh paragraph after', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: plugins() }
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertHorizontalRule' });
		expect(shape(edytor)).toEqual(['divider:', 'paragraph:']);
		expect(edytor.selection.state.startText).toBe(textOf(edytor, [1]));
	});

	pin('divider at a block start goes before it, the caret stays', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|ab</paragraph>
			</root>,
			{ plugins: plugins() }
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertHorizontalRule' });
		expect(shape(edytor)).toEqual(['divider:', 'paragraph:ab']);
		expect(edytor.selection.state.startText).toBe(textOf(edytor, [1]));
		expect(edytor.selection.state.yStart).toBe(0);
	});

	row('Backspace merge unnesting children: refusing the children move', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>a</paragraph>
				<paragraph>
					|b
					<paragraph>c</paragraph>
				</paragraph>
			</root>,
			{ plugins: plugins(vetoing('moveBlock', 'c')) }
		);
		await expectRefusedWhole(edytor, () =>
			dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' })
		);
	});

	row('Delete merge unnesting children: refusing the children move', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>a|</paragraph>
				<paragraph>
					b<paragraph>c</paragraph>
				</paragraph>
			</root>,
			{ plugins: plugins(vetoing('moveBlock', 'c')) }
		);
		await expectRefusedWhole(edytor, () =>
			dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' })
		);
	});

	row('Tab: refusing the planned move refuses the nest', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>a</paragraph>
				<paragraph>b|</paragraph>
			</root>,
			{ plugins: plugins(vetoing('moveBlock', 'b')) }
		);
		await expectRefusedWhole(edytor, () => dispatchDomKeyDown(editor, { key: 'Tab' }));
	});

	row('Shift+Tab: refusing the planned move refuses the unnest', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>
					a<paragraph>b|</paragraph>
				</paragraph>
			</root>,
			{ plugins: plugins(vetoing('moveBlock', 'b')) }
		);
		await expectRefusedWhole(edytor, () =>
			dispatchDomKeyDown(editor, { key: 'Tab', shiftKey: true })
		);
	});
});
