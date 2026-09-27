/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint R5 rows (dom lane): the host renders a pure function of
 * the model and declared view state (plan R11, §2.4 "Placeholder attribute",
 * §4.4 components row, §8.5 F-P7, F-P8, F-P19 attach half, §11.2 D-8, L4).
 *
 * - F-P7: one element carries a block's `data-edytor-id`; its handle mounts once.
 * - F-P8: a suggested mention renders unselected and non-editable.
 * - F-P19 (attach half): `onBlockAttached` receives the element the core
 *   renders, once per mount; a kind declares its element; a declared void kind
 *   is non-editable without `use:block.void`.
 * - D-8: the placeholder is `data-placeholder` on the empty text, from a string
 *   or `(view: {type, data, focused, empty}) => string | null`.
 * - L4: pending marks live in the selection value and clear when the caret moves.
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import type { Plugin } from '$lib/plugins.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

/** Red on the reference (`arch-v2/ref-r5`): expected-fail until R5 lands. */
const row = it.fails;
/** Green on the reference: a regression guard. */
const pin = it;

const attachLog =
	(log: { id: string; node: HTMLElement }[]): Plugin =>
	() => ({
		onBlockAttached: ({ node, block }) => {
			log.push({ id: block.id, node });
			return () => {};
		}
	});

const inner = (html: string) =>
	createRawSnippet(() => ({
		render: () => html
	})) as never;

describe('R5 — the core renders the block element', () => {
	row('F-P7 a code block: one element carries its id; its handle mounts once', async () => {
		const log: { id: string; node: HTMLElement }[] = [];
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>a</paragraph>
			</root>,
			{
				plugins: [attachLog(log), richTextPlugin, mentionPlugin, codePlugin],
				value: {
					children: [
						{
							id: 'c',
							type: 'code',
							children: [{ id: 'l', type: 'codeLine', content: [{ text: 'const a = 1' }] }]
						}
					]
				}
			}
		);
		await flushDomUpdates();
		const claimed = editor.querySelectorAll('[data-edytor-id="c"]');
		expect(claimed.length).toBe(1);
		expect(claimed[0]).toBe(edytor.idToBlock.get('c')?.node);
		expect(log.filter((entry) => entry.id === 'c').length).toBe(1);
		expect(
			document.querySelectorAll('[data-testid="block-handle"][data-block-id="c"]').length
		).toBe(1);
	});

	pin('onBlockAttached receives the element the core rendered for each block', async () => {
		const log: { id: string; node: HTMLElement }[] = [];
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>a</paragraph>
				<heading level="h2">b</heading>
				<quote>c</quote>
			</root>,
			{ plugins: [attachLog(log), richTextPlugin, mentionPlugin] }
		);
		const ids = edytor.root!.children.map((block) => block.id);
		expect(log.map((entry) => entry.id).sort()).toEqual([...ids].sort());
		for (const { id, node } of log) {
			expect(node.getAttribute('data-edytor-id')).toBe(id);
			expect(node.getAttribute('data-edytor-block')).toBe('true');
			expect(node).toBe(edytor.idToBlock.get(id)?.node);
		}
		expect(log.find((entry) => entry.id === ids[1])?.node.tagName).toBe('H2');
		expect(log.find((entry) => entry.id === ids[2])?.node.tagName).toBe('BLOCKQUOTE');
	});

	row(
		'a kind declares its element (tag and attributes from data); the snippet renders inside it',
		async () => {
			const banner: Plugin = () => ({
				blocks: {
					banner: {
						rendersContent: false,
						element: (data: Record<string, unknown>) => ({
							tag: 'aside',
							attributes: { 'data-tone': String(data.tone) }
						}),
						snippet: inner('<span data-banner-inner></span>')
					} as never
				}
			});
			const { editor } = await renderDomEdytor(
				<root>
					<paragraph>a</paragraph>
				</root>,
				{
					plugins: [richTextPlugin, mentionPlugin, banner],
					value: { children: [{ id: 'b', type: 'banner', data: { tone: 'warm' } }] }
				}
			);
			const element = editor.querySelector('[data-edytor-id="b"]');
			expect(element?.tagName).toBe('ASIDE');
			expect(element?.getAttribute('data-tone')).toBe('warm');
			expect(element?.getAttribute('data-edytor-type')).toBe('banner');
			expect(element?.querySelector(':scope > [data-banner-inner]')).not.toBeNull();
		}
	);

	row('a declared void kind is non-editable without use:block.void', async () => {
		const figure: Plugin = () => ({
			blocks: {
				figureKind: {
					void: true,
					rendersContent: false,
					element: 'figure',
					snippet: inner('<i data-figure-inner></i>')
				} as never
			}
		});
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>a</paragraph>
			</root>,
			{
				plugins: [richTextPlugin, mentionPlugin, figure],
				value: {
					children: [
						{ id: 'p', type: 'paragraph', content: [{ text: 'a' }] },
						{ id: 'f', type: 'figureKind' }
					]
				}
			}
		);
		const element = editor.querySelector('[data-edytor-id="f"]');
		expect(element?.tagName).toBe('FIGURE');
		expect(element?.getAttribute('data-edytor-void')).toBe('true');
		expect(element?.getAttribute('contenteditable')).toBe('false');
	});

	pin('a heading level change re-renders its element under the same id', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<heading level="h1">Title</heading>
			</root>
		);
		const heading = edytor.root!.children[0]!;
		heading.setBlock({ value: { data: { level: 'h2' } } });
		await flushDomUpdates();
		const element = editor.querySelector(`[data-edytor-id="${heading.id}"]`);
		expect(element?.tagName).toBe('H2');
		expect(heading.node).toBe(element);
	});

	pin('F-P8 a suggested mention renders unselected and non-editable', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		block.suggestText({ value: [{ text: ' to ' }, { type: 'mention', data: {} }] });
		await flushDomUpdates();
		const suggestion = editor.querySelector<HTMLElement>('[data-edytor-text-suggestion]');
		expect(suggestion).not.toBeNull();
		expect(suggestion?.getAttribute('contenteditable')).toBe('false');
		const mention = suggestion?.querySelector('[data-edytor-mention]');
		expect(mention?.textContent).toContain('false');
		expect(mention?.textContent).not.toContain('selected');
		expect(mention?.className ?? '').not.toContain('ring');
	});
});

describe('R5 — the placeholder is an attribute (D-8)', () => {
	const placeholderElements = (root: HTMLElement) =>
		root.querySelectorAll('[data-edytor-text-placeholder]').length;

	row('an empty block shows data-placeholder on its text; typing removes it', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
				<paragraph>tail</paragraph>
			</root>,
			{ placeholder: 'Start writing' }
		);
		const marked = () =>
			Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-text][data-placeholder]'));
		expect(marked().map((node) => node.getAttribute('data-placeholder'))).toEqual([
			'Start writing'
		]);
		expect(placeholderElements(editor)).toBe(0);
		expect(marked()[0]).toBe(edytor.root!.children[0]!.firstText?.node);

		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'A' });
		await flushDomUpdates();
		expect(marked()).toEqual([]);
		expect(placeholderElements(editor)).toBe(0);
	});

	row(
		'the placeholder function receives {type, data, focused, empty}; null shows none',
		async () => {
			const seen: { type: string; data: unknown; focused: boolean; empty: boolean }[] = [];
			const placeholder = (view: {
				type: string;
				data: unknown;
				focused: boolean;
				empty: boolean;
			}) => {
				seen.push({ type: view.type, data: view.data, focused: view.focused, empty: view.empty });
				return view.focused ? `Type in ${view.type}` : null;
			};
			const { editor } = await renderDomEdytor(
				<root>
					<paragraph>|</paragraph>
					<heading level="h2"></heading>
				</root>,
				{ placeholder: placeholder as never }
			);
			await flushDomUpdates();
			const marked = Array.from(
				editor.querySelectorAll<HTMLElement>('[data-edytor-text][data-placeholder]')
			);
			expect(marked.map((node) => node.getAttribute('data-placeholder'))).toEqual([
				'Type in paragraph'
			]);
			expect(seen).toContainEqual({ type: 'paragraph', data: {}, focused: true, empty: true });
			expect(seen).toContainEqual({
				type: 'heading',
				data: { level: 'h2' },
				focused: false,
				empty: true
			});
		}
	);
});

describe('R5 — pending marks live in the selection value (L4)', () => {
	row('Mod+B at a caret stages pending marks on the value, values kept', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		await dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', metaKey: true });
		const value = edytor.selection.value;
		expect(value.kind).toBe('text');
		expect(value.kind === 'text' ? value.pending : undefined).toEqual({ bold: true });
	});

	row('re-selecting the same caret keeps them; moving the caret clears them', async () => {
		const {
			editor,
			edytor,
			expect: expectValue
		} = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText!;
		await dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', metaKey: true });
		await edytor.selection.setAtTextOffset(text, 5);
		const kept = edytor.selection.value;
		expect(kept.kind === 'text' ? kept.pending : undefined).toEqual({ bold: true });

		await edytor.selection.setAtTextOffset(text, 2);
		const moved = edytor.selection.value;
		expect(moved.kind === 'text' ? moved.pending : 'none').toBeUndefined();
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		await flushDomUpdates();
		expectValue(
			<root>
				<paragraph>Hexllo</paragraph>
			</root>
		);
	});

	pin('typing consumes the pending marks', async () => {
		const {
			editor,
			edytor,
			expect: expectValue
		} = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		await dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', metaKey: true });
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
		await flushDomUpdates();
		expectValue(
			<root>
				<paragraph>
					Hello<bold>!</bold>
				</paragraph>
			</root>
		);
		const value = edytor.selection.value;
		expect(value.kind === 'text' ? value.pending : undefined).toBeUndefined();
	});
});
