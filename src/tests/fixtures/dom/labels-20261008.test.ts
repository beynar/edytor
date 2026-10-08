/**
 * Localization: a view whose plugins (and `<Edytor labels>`) take the
 * French dictionary (`fixtures/labels.fr.ts`) shows and says French only.
 * Expected words come from that dictionary, never from a run:
 *
 * - each chrome (slash menu, toolbar, block menu, handles, image, media,
 *   code header, find bar, suggestion bar, comments sidebar, columns, announcements,
 *   placeholders, the to-do checkbox, the block menu's Color flyout, the
 *   page and table of contents blocks) names itself in its plugin's labels;
 * - the slash keywords of `createRichTextPlugin({ keywords })` replace the
 *   English ones;
 * - a listed `createRichTextPlugin` replaces the default rich text plugin;
 * - across those states, no English word of the dictionary reaches the page.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import Localized from '../../dom/Localized.svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { englishLabels, type Labels } from '$lib/labels.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { findController } from '$lib/plugins/find/findPlugin.js';
import { commentsController } from '$lib/plugins/comments/commentsPlugin.js';
import {
	dispatchClipboardPaste,
	dispatchDomBeforeInput,
	flushDomUpdates
} from '../../dom/test.utils.js';
import { fr } from '../labels.fr.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const p = (id: string, text = ''): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });

const setup = async (children: JSONBlock[]) => {
	let edytor: Edytor | undefined;
	render(Localized, {
		props: {
			value: { children },
			get edytor() {
				return edytor;
			},
			set edytor(value) {
				edytor = value;
			}
		}
	});
	await flushDomUpdates();
	return { edytor: edytor!, editor: document.querySelector<HTMLElement>('[data-edytor]')! };
};

const one = <E extends Element = HTMLElement>(selector: string) => {
	const found = document.querySelector<E>(selector);
	if (!found) throw new Error(`nothing matches ${selector}`);
	return found;
};
const texts = (selector: string) =>
	[...document.querySelectorAll(selector)].map((node) => node.textContent?.trim());
/** The words of a control after its icon (`🖼 Add an image`). */
const words = (selector: string) =>
	[...document.querySelectorAll(selector)].map((node) =>
		node.textContent?.replace(/^[^\p{L}]+/u, '').trim()
	);
const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
const type = async (editor: HTMLElement, value: string) => {
	for (const data of value) await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
};
const caretIn = async (edytor: Edytor, id: string, offset = 0) => {
	edytor.selection.setAtTextOffset(edytor.idToBlock.get(id)!.firstText!, offset);
	await flushDomUpdates();
};
const activate = async (edytor: Edytor, editor: HTMLElement, id: string) => {
	const block = edytor.idToBlock.get(id)!;
	editor.dispatchEvent(
		new CustomEvent(BLOCK_ACTIVATE_EVENT, {
			bubbles: true,
			cancelable: true,
			detail: { block, anchor: block.node }
		})
	);
	await flushDomUpdates();
};

/** The attributes that show or name something to people. */
const SAID = ['aria-label', 'title', 'placeholder', 'alt', 'data-placeholder', 'data-hint'];

/** Every word the page shows or names: its text, and its attributes people see or hear. */
const pageWords = () => {
	const words: string[] = [];
	const walk = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) words.push(node.textContent ?? '');
		if (node instanceof Element) for (const name of SAID) words.push(node.getAttribute(name) ?? '');
		node.childNodes.forEach(walk);
	};
	walk(document.body);
	return words.join('\n');
};

/** `page` says `word`, as a word (`Text` is not in `Texte`). */
const says = (page: string, word: string) =>
	new RegExp(`(?<![\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u').test(
		page
	);

/** Stands for a value a label says (a kind, a count): its words are what is around it. */
const VALUE = '\u0000';

/** The dictionary's words: each string, and the words a function says around its values. */
const wordsOf = (labels: Labels) => {
	const out: string[] = [];
	const visit = (value: unknown) => {
		if (typeof value === 'string') out.push(value);
		else if (typeof value === 'function') {
			const said = (value as (...args: unknown[]) => unknown)(VALUE, VALUE);
			if (typeof said === 'string') out.push(...said.split(VALUE).map((part) => part.trim()));
		} else if (value && typeof value === 'object') Object.values(value).forEach(visit);
	};
	visit(labels);
	return out.filter((word) => /[A-Za-z]{2}/.test(word));
};
/** The English words French says otherwise (`Code` and `Image` are both). */
const english = () => {
	const french = new Set(wordsOf(fr));
	return [...new Set(wordsOf(englishLabels))].filter(
		(word) => word.length > 2 && !french.has(word)
	);
};

describe('the rich text factory', () => {
	it('a listed createRichTextPlugin replaces the default rich text plugin', async () => {
		const { edytor } = await setup([p('a')]);
		// One plugin declares the paragraph: the listed one, no default beside it.
		expect(edytor.plugins.filter((plugin) => plugin.blocks?.paragraph)).toHaveLength(1);
		expect(edytor.commands.get('block.heading1')?.label).toBe(fr.richText.kinds.heading1);
	});

	it('the slash menu matches the localized keywords', async () => {
		const { edytor, editor } = await setup([p('a')]);
		await caretIn(edytor, 'a');
		await type(editor, '/titre');
		expect(texts('[data-testid="slash-menu-item"]')[0]).toBe(fr.richText.kinds.heading1);
	});

	it('not the English ones they replace: a query no row matches closes the menu', async () => {
		const { edytor, editor } = await setup([p('a')]);
		await caretIn(edytor, 'a');
		await type(editor, '/heading');
		expect(document.querySelector('[data-testid="slash-menu"]')).toBeNull();
	});

	it('the placeholders and the to-do checkbox are French', async () => {
		const { edytor } = await setup([
			{ id: 'h', type: 'heading', data: { level: 'h2' }, content: [{ text: '' }] },
			{ id: 't', type: 'todo-item', content: [{ text: 'faire' }] }
		]);
		void edytor;
		expect(one('[data-edytor-id="h"] [data-placeholder]').dataset.placeholder).toBe(
			fr.richText.placeholders.heading(2)
		);
		expect(one('[data-edytor-todo-checkbox]').getAttribute('aria-label')).toBe(
			fr.richText.checkbox
		);
	});
});

describe('each chrome in its labels', () => {
	it('the slash menu: headings by group key, rows, close', async () => {
		const { edytor, editor } = await setup([p('a')]);
		await caretIn(edytor, 'a');
		await type(editor, '/');
		const headings = texts('.slash-heading');
		expect(headings).toContain(fr.slashMenu.groups['Basic blocks']);
		expect(headings).toContain(fr.slashMenu.groups.Media);
		expect(headings).toContain(fr.slashMenu.groups.Layout);
		expect(headings[0]).toBe(fr.slashMenu.groups['Basic blocks']);
		expect(texts('[data-testid="slash-menu-item"]')).toContain(fr.columns.columns(2));
		expect(one('.slash-items').getAttribute('aria-label')).toBe(fr.slashMenu.list);
		expect(one('.slash-footer span').textContent).toBe(fr.slashMenu.close);
	});

	it('the toolbar: the bar, the kind, the marks, the color panel', async () => {
		const { edytor } = await setup([p('a', 'bonjour')]);
		const text = edytor.idToBlock.get('a')!.firstText!;
		edytor.selection.setAtRange(text, 0, text, 7);
		await flushDomUpdates();
		const bar = one('[data-testid="selection-toolbar"]');
		expect(bar.getAttribute('aria-label')).toBe(fr.toolbar.bar);
		expect(one('.toolbar-type').textContent).toBe(fr.richText.kinds.paragraph);
		expect(one('[data-testid="toolbar-link"]').textContent).toBe(fr.toolbar.link);
		expect(one('[data-testid="toolbar-bold"]').getAttribute('aria-label')).toBe(
			fr.richText.marks.bold
		);
		await click(one('.toolbar-color'));
		expect(texts('.toolbar-heading')).toEqual([fr.toolbar.textColor, fr.toolbar.backgroundColor]);
		const swatches = [...document.querySelectorAll('.toolbar-swatch')].map((s) =>
			s.getAttribute('title')
		);
		expect(swatches).toContain(fr.toolbar.colorText(fr.toolbar.colors.Red!));
		expect(swatches).toContain(fr.toolbar.colorBackground(fr.toolbar.colors.Red!));
	});

	it('the block menu: its actions, search and headings', async () => {
		const { edytor, editor } = await setup([
			{ id: 'h', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Titre' }] },
			p('a', 'texte')
		]);
		await activate(edytor, editor, 'h');
		const menu = one('[data-testid="block-menu"]');
		expect(one<HTMLInputElement>('.block-menu-search input').placeholder).toBe(fr.blockMenu.search);
		expect(texts('[data-testid="block-menu"] .block-menu-heading')[0]).toBe(
			fr.richText.kinds.heading1
		);
		const rows = [...menu.querySelectorAll('.block-menu-row')].map((row) => row.textContent);
		for (const label of [
			fr.blockMenu.turnInto,
			fr.blockMenu.copyLink,
			fr.blockMenu.duplicate,
			fr.blockMenu.moveDown,
			fr.blockMenu.delete
		])
			expect(rows).toContain(label);
		expect(one('[data-testid="block-menu-delete"]').dataset.hint).toBe(fr.blockMenu.deleteKey);
	});

	it("the block menu's Color flyout: its name, sections and rows", async () => {
		const { edytor, editor } = await setup([p('a', 'texte')]);
		await activate(edytor, editor, 'a');
		const row = one('[data-testid="block-menu-color"]');
		expect(row.textContent).toBe(fr.blockMenu.color);
		row.dispatchEvent(new MouseEvent('mouseenter'));
		await flushDomUpdates();
		expect(one('[data-edytor-block-menu-flyout]').getAttribute('aria-label')).toBe(
			fr.blockMenu.color
		);
		expect(texts('[data-edytor-block-menu-flyout] .block-menu-heading')).toEqual([
			fr.blockMenu.textColor,
			fr.blockMenu.backgroundColor
		]);
		expect(one('[data-testid="block-menu-color.red"]').textContent).toBe(
			fr.blockMenu.colorText(fr.blockMenu.colors.red!)
		);
		expect(one('[data-testid="block-menu-background.default"]').textContent).toBe(
			fr.blockMenu.colorBackground(fr.blockMenu.colors.default!)
		);
	});

	it('the page and table of contents blocks: untitled, the empty hint, their presets', async () => {
		const { edytor, editor } = await setup([
			{ id: 'g', type: 'page', data: { pageId: 'p1' } },
			{ id: 'n', type: 'toc' },
			p('a')
		]);
		expect(one('[data-edytor-page-title]').textContent).toBe(fr.page.untitled);
		expect(one('[data-edytor-toc-empty]').textContent).toBe(fr.toc.empty);
		expect(one('[data-edytor-id="n"]').getAttribute('aria-label')).toBe(fr.toc.toc);
		await caretIn(edytor, 'a');
		await type(editor, '/');
		const rows = texts('[data-testid="slash-menu-item"]');
		expect(rows).toContain(fr.page.page);
		expect(rows).toContain(fr.toc.toc);
		expect(texts('.slash-heading')).toContain(fr.slashMenu.groups['Advanced blocks']);
	});

	it('the handles: named after the kind, in the labels', async () => {
		await setup([{ id: 'h', type: 'heading', data: { level: 'h1' }, content: [{ text: 'T' }] }]);
		expect(one('[data-testid="block-handle"][data-block-id="h"]').getAttribute('aria-label')).toBe(
			fr.blockHandles.grip(fr.richText.kinds.heading1)
		);
		expect(one('[data-testid="block-add"]').getAttribute('aria-label')).toBe(
			fr.blockHandles.add(fr.richText.kinds.heading1)
		);
	});

	it('the image and the media blocks: their empty panels, a file size', async () => {
		await setup([
			{ id: 'i', type: 'image', content: [{ text: '' }] },
			{ id: 'e', type: 'embed', content: [{ text: '' }] },
			{ id: 'b', type: 'bookmark', content: [{ text: '' }] },
			{ id: 'f', type: 'file', content: [{ text: '' }] },
			{ id: 'v', type: 'video', content: [{ text: '' }] },
			{ id: 'u', type: 'audio', content: [{ text: '' }] },
			{
				id: 'g',
				type: 'file',
				data: { src: 'https://example.com/a.pdf', name: 'a.pdf', size: 1536 },
				content: [{ text: '' }]
			}
		]);
		expect(words('[data-edytor-image-add]')).toEqual([fr.image.add]);
		expect(words('[data-edytor-media-add]')).toEqual([
			fr.media.embed.add,
			fr.media.bookmark.add,
			fr.media.file.addOrUpload,
			fr.media.video.add,
			fr.media.audio.add
		]);
		expect(one('[data-edytor-file-size]').textContent).toBe(fr.media.fileSize(1536));
		await click(one('[data-edytor-id="v"] [data-edytor-media-add]'));
		expect(one<HTMLInputElement>('[data-edytor-media-form] input').placeholder).toBe(
			fr.media.video.placeholder
		);
		expect(one('[data-edytor-media-upload]').textContent?.trim()).toBe(fr.media.upload);
	});

	it('a pasted link: the menu and its rows', async () => {
		const { edytor, editor } = await setup([p('a')]);
		await caretIn(edytor, 'a');
		await dispatchClipboardPaste(editor, { 'text/plain': 'https://example.com/page' });
		expect(one('[data-edytor-url-paste-menu]').getAttribute('aria-label')).toBe(fr.media.pasteAs);
		expect(words('[data-edytor-url-paste-option]')).toEqual([
			fr.media.pasteLink,
			fr.media.bookmark.offer
		]);
	});

	it('the code header: the picker, a language, the copy button', async () => {
		await setup([
			{
				id: 'c',
				type: 'code',
				data: { language: 'plaintext' },
				children: [{ id: 'l', type: 'codeLine', content: [{ text: 'x' }] }]
			}
		]);
		const picker = one<HTMLSelectElement>('[data-edytor-code-language]');
		expect(picker.getAttribute('aria-label')).toBe(fr.code.language);
		expect(picker.selectedOptions[0]?.textContent).toBe(fr.code.languages.plaintext);
		expect(one('[data-edytor-code-header] button').textContent).toBe(fr.code.copy);
	});

	it('the find bar: fields, count, buttons', async () => {
		const { edytor } = await setup([p('a', 'un deux un')]);
		findController(edytor)!.open('un');
		await flushDomUpdates();
		expect(one('[data-edytor-find]').getAttribute('aria-label')).toBe(fr.find.bar);
		expect(one<HTMLInputElement>('[data-edytor-find-query]').placeholder).toBe(
			fr.find.queryPlaceholder
		);
		expect(one('[data-edytor-find-count]').textContent).toBe(fr.find.count(1, 2));
		expect(one('[data-edytor-find-replace-all]').textContent).toBe(fr.find.replaceAll);
	});

	it('the suggestion bar and its preview', async () => {
		const { edytor } = await setup([p('a', 'texte')]);
		edytor.suggestions.add({ after: 'a' }, [p('s', 'proposé')]);
		await flushDomUpdates();
		expect(one('[data-edytor-suggestion-accept]').textContent).toContain(fr.suggestions.accept);
		expect(one('[data-edytor-suggestion-discard]').textContent).toContain(fr.suggestions.discard);
		expect(one('[data-edytor-suggestion-label]').textContent).toBe(fr.suggestions.suggestion);
		expect(one('[data-edytor-suggestion]').getAttribute('aria-label')).toBe(fr.editor.suggestion);
	});

	it("a suggestion's preview (no block handle) speaks the view's labels", async () => {
		const { edytor } = await setup([p('a', 'texte')]);
		edytor.suggestions.add({ after: 'a' }, [
			{ id: 't', type: 'todo-item', content: [{ text: 'faire' }] },
			{ id: 'v', type: 'video', content: [{ text: '' }] },
			{ id: 'i', type: 'image', content: [{ text: '' }] }
		]);
		await flushDomUpdates();
		const preview = one('[data-edytor-suggestion]');
		expect(preview.querySelector('[data-edytor-todo-checkbox]')?.getAttribute('aria-label')).toBe(
			fr.richText.checkbox
		);
		expect(
			preview.querySelector('[data-edytor-media-placeholder]')?.textContent?.replace(/^\S+\s*/, '')
		).toBe(fr.media.video.add);
		expect(
			preview.querySelector('[data-edytor-image-placeholder]')?.textContent?.replace(/^\S+\s*/, '')
		).toBe(fr.image.image);
	});

	it('the announcements: a move and a delete', async () => {
		const { edytor, editor } = await setup([p('a', 'un'), p('b', 'deux')]);
		edytor.moveBlocks({ blocks: [edytor.idToBlock.get('a')!], direction: 'down' });
		await flushDomUpdates();
		const what = fr.editor.block(fr.richText.kinds.paragraph);
		expect(one('[data-edytor-live]').textContent).toBe(fr.editor.movedDown(what));
		await activate(edytor, editor, 'b');
		await click(one('[data-testid="block-menu-delete"]'));
		expect(one('[data-edytor-live]').textContent).toBe(fr.editor.deleted(what));
	});
});

describe('no English reaches the page', () => {
	it('across the menus, panels and bars of a French view', async () => {
		const { edytor, editor } = await setup([
			{ id: 'h', type: 'heading', data: { level: 'h1' }, content: [{ text: '' }] },
			p('a', 'bonjour le monde'),
			{ id: 't', type: 'todo-item', content: [{ text: '' }] },
			{ id: 'q', type: 'quote', content: [{ text: '' }] },
			{ id: 'i', type: 'image', content: [{ text: '' }] },
			{ id: 'e', type: 'embed', content: [{ text: '' }] },
			{ id: 'v', type: 'video', content: [{ text: '' }] },
			{
				id: 'c',
				type: 'code',
				data: { language: 'plaintext' },
				children: [{ id: 'l', type: 'codeLine', content: [{ text: 'x' }] }]
			},
			{ id: 'g', type: 'page', data: { pageId: 'p1' } },
			{ id: 'n', type: 'toc' },
			p('z')
		]);
		const seen: string[] = [];
		const look = () => seen.push(pageWords());
		look();
		const text = edytor.idToBlock.get('a')!.firstText!;
		edytor.selection.setAtRange(text, 0, text, 7);
		await flushDomUpdates();
		look();
		await click(one('.toolbar-color'));
		look();
		await click(one('.toolbar-type'));
		look();
		await caretIn(edytor, 'z');
		await type(editor, '/');
		look();
		await type(editor, 'zzzz');
		look();
		await activate(edytor, editor, 'a');
		look();
		one('[data-testid="block-menu-color"]').dispatchEvent(new MouseEvent('mouseenter'));
		await flushDomUpdates();
		look();
		findController(edytor)!.open('monde');
		await flushDomUpdates();
		look();
		edytor.suggestions.add({ after: 'a' }, [p('s', 'proposé')]);
		await flushDomUpdates();
		look();
		// A comment thread, posted, then a resolved one (the sidebar's toggle).
		const comments = commentsController(edytor)!;
		edytor.selection.setAtRange(text, 0, text, 7);
		comments.start();
		await flushDomUpdates();
		look();
		await comments.submit('Une remarque');
		await flushDomUpdates();
		look();
		await comments.resolve(comments.threads[0]!.id);
		await flushDomUpdates();
		look();
		await click(one('[data-edytor-image-add]'));
		await click(one('[data-edytor-id="v"] [data-edytor-media-add]'));
		look();
		const page = seen.join('\n');
		expect(english().filter((word) => says(page, word))).toEqual([]);
	});
});
