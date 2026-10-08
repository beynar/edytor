/** @jsxImportSource ../../jsx */
/**
 * Equations: a block equation kind (`equation`) and an inline equation
 * atom (`inlineEquation`), TeX rendered by KaTeX, which the app loads
 * lazily (`createEquationPlugin({ katex: () => import('katex') })`).
 * Expected values come from the plugin's contract (site `plugins/equation`)
 * and Notion:
 *
 * - "Block equation" in the slash menu (Advanced blocks) and "Inline
 *   equation" (Inline); an empty block shows "Add a TeX equation", an empty
 *   inline one "New equation";
 * - a click on an equation of an editable view opens its editor: the TeX
 *   source in a field, the equation itself the live preview of each
 *   keystroke (one undo step for the typing); Enter or Done closes it
 *   (Shift+Enter is a newline in a block equation), Escape too; an inline
 *   equation closed empty is removed;
 * - TeX KaTeX cannot read shows as "Invalid equation" with its source;
 * - `$$x^2$$` typed in text is an inline equation (the last `$` converts it,
 *   one undo step that gives the typed text back); Mod+Shift+E turns the
 *   selected text into one, or inserts an empty one and opens its editor;
 * - copy exports MathML with the TeX source as its
 *   `application/x-tex` annotation, and HTML import reads it back (KaTeX's
 *   output, a bare `<math>`), a `display="block"` one as a block;
 * - KaTeX runs untrusted: no `\href` becomes a link.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Plugin } from '$lib/plugins.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { createEquationPlugin } from '$lib/plugins/equation/EquationPlugin.svelte';
import { defaultSemantics } from '$lib/crdt/semantics.js';
import {
	serializeClipboardFragmentToHtml,
	serializeClipboardFragmentToPlainText
} from '$lib/clipboard/serializeClipboardFragment.js';
import {
	canonicalTree,
	dispatchClipboardPaste,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const katex = () => import('katex');
const equations = createEquationPlugin({ katex });

const mount = (children: JSONBlock[], plugins: Plugin[] = [equations], readonly = false) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [...plugins, richTextPlugin], readonly, value: { children } }
	);

const p = (id: string, text = id): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });
const type = async (editor: HTMLElement, value: string) => {
	for (const data of value) await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
};
const caretAt = async (edytor: Edytor, id: string, offset: number) => {
	edytor.selection.setCaret({ block: edytor.idToBlock.get(id)!, offset });
	await flushDomUpdates();
};
/** The TeX source KaTeX rendered in `root` (its MathML annotation). */
const texIn = (root: ParentNode | null | undefined) =>
	root?.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? null;
const rendered = async (selector: string) => {
	await vi.waitFor(() => {
		if (!document.querySelector(`${selector} .katex`)) throw new Error('not rendered yet');
	});
	await flushDomUpdates();
	return document.querySelector<HTMLElement>(selector)!;
};
/** The overlay measures in its next frame. */
const frame = async () => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await flushDomUpdates();
};
const editorPanel = () => document.querySelector<HTMLElement>('[data-edytor-equation-editor]');
const field = () => editorPanel()?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
const typeInField = async (value: string) => {
	const input = field()!;
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await flushDomUpdates();
};
const key = async (target: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
	target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
	await flushDomUpdates();
};
const contentOf = (edytor: Edytor, id: string) => edytor.idToBlock.get(id)!.value.content ?? [];

describe('the kinds', () => {
	it('a block equation is void and shows no text of its own, in defaultSemantics too', async () => {
		expect(defaultSemantics.roles.equation).toEqual({ void: true });
		expect(defaultSemantics.rendersContent.equation).toBe(false);
		const { edytor } = await mount([p('a')]);
		expect(edytor.blocks.get('equation')?.void).toBe(true);
		expect(edytor.blocks.get('equation')?.rendersContent).toBe(false);
		expect(edytor.inlineBlocks.has('inlineEquation')).toBe(true);
	});

	it('the slash menu offers Block equation (Advanced blocks) and Inline equation (Inline)', async () => {
		const { edytor } = await mount([p('a')]);
		const block = edytor.commands.get('block.equation');
		expect(block?.label).toBe('Block equation');
		expect(block?.group).toBe('Advanced blocks');
		expect(block?.keywords).toEqual(expect.arrayContaining(['math', 'tex', 'latex']));
		const inline = edytor.commands.get('equation.inline');
		expect(inline?.label).toBe('Inline equation');
		expect(inline?.group).toBe('Inline');
	});
});

describe('rendering', () => {
	it('a block equation renders its TeX with KaTeX, display mode', async () => {
		await mount([{ id: 'e', type: 'equation', data: { expression: '\\frac{a}{b}' } }]);
		const view = await rendered('[data-edytor-equation]');
		expect(texIn(view)).toBe('\\frac{a}{b}');
		expect(view.querySelector('.katex-display')).not.toBeNull();
	});

	it('an inline equation renders inline, in the text', async () => {
		await mount([
			{
				id: 'a',
				type: 'paragraph',
				content: [
					{ text: 'so ' },
					{ type: 'inlineEquation', data: { expression: 'E=mc^2' } },
					{ text: ' holds' }
				]
			}
		]);
		const view = await rendered('[data-edytor-inline-equation]');
		expect(texIn(view)).toBe('E=mc^2');
		expect(view.querySelector('.katex-display')).toBeNull();
		expect(view.closest('[data-edytor-inline-block]')?.getAttribute('contenteditable')).toBe(
			'false'
		);
	});

	it('empty equations show their placeholders', async () => {
		await mount([
			{ id: 'e', type: 'equation', data: {} },
			{
				id: 'a',
				type: 'paragraph',
				content: [{ text: 'x ' }, { type: 'inlineEquation', data: { expression: '' } }]
			}
		]);
		expect(document.querySelector('[data-edytor-equation]')?.textContent).toContain(
			'Add a TeX equation'
		);
		expect(document.querySelector('[data-edytor-inline-equation]')?.textContent).toContain(
			'New equation'
		);
	});

	it('TeX KaTeX cannot read shows as an invalid equation, with its source', async () => {
		await mount([{ id: 'e', type: 'equation', data: { expression: '\\frac{' } }]);
		await vi.waitFor(() => {
			if (!document.querySelector('[data-edytor-equation-error]')) throw new Error('not yet');
		});
		const error = document.querySelector<HTMLElement>('[data-edytor-equation-error]')!;
		expect(error.textContent).toContain('\\frac{');
		expect(error.getAttribute('title')).toContain('Invalid equation');
	});

	it('without a KaTeX loader the TeX source shows as it is', async () => {
		await mount(
			[{ id: 'e', type: 'equation', data: { expression: 'x^2' } }],
			[createEquationPlugin()]
		);
		await flushDomUpdates();
		const source = document.querySelector('[data-edytor-equation] [data-edytor-equation-source]');
		expect(source?.textContent).toBe('x^2');
		expect(document.querySelector('.katex')).toBeNull();
	});

	it('KaTeX runs untrusted: \\href makes no link', async () => {
		await mount([
			{ id: 'e', type: 'equation', data: { expression: '\\href{javascript:alert(1)}{x} + y' } }
		]);
		await vi.waitFor(() => {
			const view = document.querySelector('[data-edytor-equation]');
			if (!view?.querySelector('.katex, [data-edytor-equation-error]')) throw new Error('not yet');
		});
		// The source stays in the MathML annotation; nothing links to it.
		expect(document.querySelector('[data-edytor-equation] a')).toBeNull();
		expect(document.querySelector('[href*="javascript"]')).toBeNull();
	});
});

describe('the editor', () => {
	it('a click opens the source; each keystroke previews live; Enter closes; the typing is one step', async () => {
		const { edytor } = await mount([
			p('a'),
			{ id: 'e', type: 'equation', data: { expression: 'x' } }
		]);
		const view = await rendered('[data-edytor-equation]');
		view.click();
		await frame();
		const panel = editorPanel()!;
		expect(panel).not.toBeNull();
		// Chrome lives in the overlay, never inside the host.
		expect(panel.closest('[data-edytor-overlay]')).not.toBeNull();
		expect(edytor.node!.contains(panel)).toBe(false);
		expect(field()!.value).toBe('x');

		const steps = edytor.undoManager.undoStack.length;
		await typeInField('x^');
		await typeInField('x^2');
		expect(edytor.idToBlock.get('e')!.data.expression).toBe('x^2');
		await vi.waitFor(() =>
			expect(texIn(document.querySelector('[data-edytor-equation]'))).toBe('x^2')
		);
		expect(edytor.undoManager.undoStack.length).toBe(steps + 1);

		await key(field()!, 'Enter');
		expect(editorPanel()).toBeNull();
		expect(edytor.selection.value).toEqual({ kind: 'blocks', ids: ['e'] });
		edytor.historyUndo();
		await flushDomUpdates();
		expect(edytor.idToBlock.get('e')!.data.expression).toBe('x');
	});

	it('Shift+Enter is a newline in a block equation; Escape closes and keeps it', async () => {
		const { edytor } = await mount([{ id: 'e', type: 'equation', data: { expression: 'a' } }]);
		(await rendered('[data-edytor-equation]')).click();
		await frame();
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			shiftKey: true,
			bubbles: true,
			cancelable: true
		});
		field()!.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		await typeInField('a \\\\\nb');
		await key(field()!, 'Escape');
		expect(editorPanel()).toBeNull();
		expect(edytor.idToBlock.get('e')!.data.expression).toBe('a \\\\\nb');
	});

	it('the Done button closes it', async () => {
		await mount([{ id: 'e', type: 'equation', data: { expression: 'a' } }]);
		(await rendered('[data-edytor-equation]')).click();
		await frame();
		editorPanel()!.querySelector<HTMLButtonElement>('[data-edytor-equation-done]')!.click();
		await frame();
		expect(editorPanel()).toBeNull();
	});

	it('a readonly view opens nothing', async () => {
		await mount([{ id: 'e', type: 'equation', data: { expression: 'x' } }], [equations], true);
		(await rendered('[data-edytor-equation]')).click();
		await frame();
		expect(editorPanel()).toBeNull();
	});

	it('an inline equation opens on a click; closed empty, it is removed', async () => {
		const { edytor } = await mount([
			{
				id: 'a',
				type: 'paragraph',
				content: [
					{ text: 'so ' },
					{ type: 'inlineEquation', data: { expression: 'y' } },
					{ text: '!' }
				]
			}
		]);
		(await rendered('[data-edytor-inline-equation]')).click();
		await frame();
		expect(field()!.value).toBe('y');
		await typeInField('');
		await key(field()!, 'Enter');
		expect(editorPanel()).toBeNull();
		expect(contentOf(edytor, 'a')).toEqual([{ text: 'so !' }]);
	});

	it('a new block equation from the slash command opens its editor', async () => {
		const { edytor } = await mount([p('a', '')]);
		await caretAt(edytor, 'a', 0);
		await edytor.commands.get('block.equation')!.run(edytor);
		await frame();
		await vi.waitFor(() => expect(editorPanel()).not.toBeNull());
		// A void takes the line; the caret goes to a new one after it (as a divider's).
		expect(canonicalTree(edytor)).toEqual([{ type: 'equation' }, { type: 'paragraph' }]);
		await typeInField('\\sqrt{2}');
		await key(field()!, 'Enter');
		expect(canonicalTree(edytor)).toEqual([
			{ type: 'equation', data: { expression: '\\sqrt{2}' } },
			{ type: 'paragraph' }
		]);
	});
});

describe('creating inline equations', () => {
	it('$$x^2$$ typed in text becomes an inline equation; undo gives the text back', async () => {
		const { edytor, editor } = await mount([p('a', 'so ')]);
		await caretAt(edytor, 'a', 3);
		await type(editor, '$$x^2$$');
		expect(contentOf(edytor, 'a')).toEqual([
			{ text: 'so ' },
			expect.objectContaining({ type: 'inlineEquation', data: { expression: 'x^2' } })
		]);
		expect(edytor.selection.caret).toMatchObject({ offset: 4 });
		edytor.historyUndo();
		await flushDomUpdates();
		expect(contentOf(edytor, 'a')).toEqual([{ text: 'so $$x^2$' }]);
	});

	it('Mod+Shift+E turns the selected text into an inline equation, one step', async () => {
		const { edytor, editor } = await mount([p('a', 'area a^2 here')]);
		const text = edytor.idToBlock.get('a')!.firstText!;
		await setNativeSelection(edytor, text, 5, text, 8);
		await dispatchDomKeyDown(editor, { key: 'E', metaKey: true, shiftKey: true });
		expect(contentOf(edytor, 'a')).toEqual([
			{ text: 'area ' },
			expect.objectContaining({ type: 'inlineEquation', data: { expression: 'a^2' } }),
			{ text: ' here' }
		]);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(contentOf(edytor, 'a')).toEqual([{ text: 'area a^2 here' }]);
	});

	it('Mod+Shift+E over a block’s whole text: the equation, the caret after it', async () => {
		const { edytor, editor } = await mount([p('a', 'x^2')]);
		const text = edytor.idToBlock.get('a')!.firstText!;
		await setNativeSelection(edytor, text, 0, text, 3);
		await dispatchDomKeyDown(editor, { key: 'E', metaKey: true, shiftKey: true });
		expect(contentOf(edytor, 'a')).toEqual([
			expect.objectContaining({ type: 'inlineEquation', data: { expression: 'x^2' } })
		]);
		expect(edytor.selection.caret).toMatchObject({ offset: 1 });
	});

	it('Mod+Shift+E: a hook refusing the equation keeps the selected text (one plan)', async () => {
		const seen: string[] = [];
		const noAtoms: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				seen.push(operation);
				if (operation === 'addInlineBlock') prevent();
			}
		});
		const { edytor, editor } = await mount([p('a', 'area a^2 here')], [noAtoms, equations]);
		const text = edytor.idToBlock.get('a')!.firstText!;
		await setNativeSelection(edytor, text, 5, text, 8);
		await dispatchDomKeyDown(editor, { key: 'E', metaKey: true, shiftKey: true });
		expect(seen).toContain('addInlineBlock');
		expect(contentOf(edytor, 'a')).toEqual([{ text: 'area a^2 here' }]);
	});

	it('Mod+Shift+E: a hook refusing the deletion keeps the text, and no equation lands', async () => {
		const noDeletes: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if (operation === 'deleteContentAtRange') prevent();
			}
		});
		const { edytor, editor } = await mount([p('a', 'area a^2 here')], [noDeletes, equations]);
		const text = edytor.idToBlock.get('a')!.firstText!;
		await setNativeSelection(edytor, text, 5, text, 8);
		await dispatchDomKeyDown(editor, { key: 'E', metaKey: true, shiftKey: true });
		expect(contentOf(edytor, 'a')).toEqual([{ text: 'area a^2 here' }]);
	});

	it('at a caret, Inline equation inserts an empty one and opens its editor', async () => {
		const { edytor } = await mount([p('a', 'ab')]);
		await caretAt(edytor, 'a', 1);
		await edytor.commands.get('equation.inline')!.run(edytor);
		await frame();
		expect(contentOf(edytor, 'a')).toEqual([
			{ text: 'a' },
			expect.objectContaining({ type: 'inlineEquation' }),
			{ text: 'b' }
		]);
		await vi.waitFor(() => expect(editorPanel()).not.toBeNull());
		await typeInField('\\pi');
		await key(field()!, 'Enter');
		expect(contentOf(edytor, 'a')).toEqual([
			{ text: 'a' },
			expect.objectContaining({ type: 'inlineEquation', data: { expression: '\\pi' } }),
			{ text: 'b' }
		]);
		// The caret after it (Notion).
		expect(edytor.selection.caret).toMatchObject({ offset: 2 });
	});
});

describe('clipboard', () => {
	it('copy exports MathML carrying the TeX source; plain text is the source', async () => {
		const { edytor } = await mount([p('a')]);
		const fragment = {
			version: 1 as const,
			source: 'edytor' as const,
			kind: 'blocks' as const,
			blocks: [
				{ type: 'equation', data: { expression: 'a<b' } },
				{
					type: 'paragraph',
					content: [{ text: 'so ' }, { type: 'inlineEquation', data: { expression: 'x&y' } }]
				}
			]
		};
		const html = serializeClipboardFragmentToHtml(fragment, edytor);
		const body = new DOMParser().parseFromString(html, 'text/html').body;
		const maths = [...body.querySelectorAll('math')];
		expect(maths.map((math) => math.getAttribute('display'))).toEqual(['block', null]);
		expect(maths.map((math) => texIn(math))).toEqual(['a<b', 'x&y']);
		expect(body.querySelector('p')?.textContent?.startsWith('so ')).toBe(true);
		expect(serializeClipboardFragmentToPlainText(fragment, edytor)).toBe('a<b\nso x&y');
	});

	const paste = async (html: string, plugins: Plugin[] = [equations]) => {
		const view = await mount([{ id: 'p', type: 'paragraph', content: [] }], plugins);
		await setNativeSelection(view.edytor, view.edytor.idToBlock.get('p')!.firstText, 0);
		await dispatchClipboardPaste(view.editor, { 'text/html': html, 'text/plain': 'x' });
		// The line the paste split leaves its empty tail after a block (`flow.*`).
		return canonicalTree(view.edytor).filter(
			(block, at, all) => !(at === all.length - 1 && block.type === 'paragraph' && !block.content)
		);
	};
	const tex = (value: string) =>
		`<semantics><mrow><mi>z</mi></mrow><annotation encoding="application/x-tex">${value}</annotation></semantics>`;

	it("imports KaTeX's output: an inline equation in its text, a display one as a block", async () => {
		const k = await katex();
		const inline = k.default.renderToString('E=mc^2');
		const display = k.default.renderToString('\\int_0^1 f', { displayMode: true });
		expect(await paste(`<p>Energy ${inline} holds</p>${display}`)).toEqual([
			{
				type: 'paragraph',
				content: [
					{ text: 'Energy ' },
					{ type: 'inlineEquation', data: { expression: 'E=mc^2' } },
					{ text: ' holds' }
				]
			},
			{ type: 'equation', data: { expression: '\\int_0^1 f' } }
		]);
	});

	it('imports a bare <math> by its TeX annotation (display="block": a block)', async () => {
		expect(
			await paste(`<p>a <math>${tex('x_1')}</math></p><math display="block">${tex('\\sum')}</math>`)
		).toEqual([
			{
				type: 'paragraph',
				content: [{ text: 'a ' }, { type: 'inlineEquation', data: { expression: 'x_1' } }]
			},
			{ type: 'equation', data: { expression: '\\sum' } }
		]);
	});

	it('a copied equation pastes back as itself', async () => {
		const { edytor } = await mount([p('a')]);
		const html = serializeClipboardFragmentToHtml(
			{
				version: 1,
				source: 'edytor',
				kind: 'blocks',
				blocks: [
					{ type: 'equation', data: { expression: '\\alpha' } },
					{
						type: 'paragraph',
						content: [{ text: 'b ' }, { type: 'inlineEquation', data: { expression: '\\beta' } }]
					}
				]
			},
			edytor
		);
		// Without the embedded fragment: the HTML alone, as another app reads it.
		const foreign = html.replace(/<span data-edytor-fragment="[^"]*" hidden><\/span>/, '');
		expect(await paste(foreign)).toEqual([
			{ type: 'equation', data: { expression: '\\alpha' } },
			{
				type: 'paragraph',
				content: [{ text: 'b ' }, { type: 'inlineEquation', data: { expression: '\\beta' } }]
			}
		]);
	});

	it('without the plugin, math imports nothing', async () => {
		expect(await paste(`<p>a <math>${tex('x')}</math></p>`, [])).toEqual([
			{ type: 'paragraph', content: [{ text: 'a' }] }
		]);
	});
});
