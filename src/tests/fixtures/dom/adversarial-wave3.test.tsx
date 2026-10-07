/** @jsxImportSource ../../jsx */
/**
 * Adversarial review wave 3 — regression coverage for the defects found
 * by re-reviewing the wave-2 fixes:
 *
 * - `isLiveAddedManagedElement`'s owner fall-through accepted only
 *   block/text/inline-block owners — root-level chrome like
 *   `data-edytor-render-anchor` (a direct child of the editor root) was
 *   judged unmanaged → removed on add, then re-restored on remove
 *   (the removed path is attribute-only) → remove/restore loop;
 * - link `href` rendered verbatim — `javascript:`/`data:` payloads from
 *   native insertLink, pasted HTML, or a malicious collaborator reached
 *   the DOM. `sanitizeLinkHref` allowlists schemes at both the write
 *   (`setLinkAtRange`) and render (`link` snippet) boundaries;
 * - the nested-editable selector was case-sensitive —
 *   `contenteditable="TRUE"` islands escaped `isNestedForeignEditableTarget`;
 * - `applySelectionSnapshot` derived island selections into the host
 *   text — an island caret must not move the model selection.
 */
import { describe, expect, test } from 'vitest';
import {
	renderDomEdytor,
	flushDomUpdates,
	setNativeSelection,
	dispatchDomBeforeInput,
	dispatchDomInput,
	dispatchDomKeyDown,
	dispatchComposition
} from '../../dom/test.utils.js';
import {
	sanitizeLinkHref,
	sanitizeCssColorValue
} from '$lib/plugins/richtext/richTextOperations.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const gestureSerial = (edytor: Edytor) => edytor.intentSerial;
const blockTypes = (doc: { children?: JSONBlock[] }) =>
	(doc.children ?? []).map((block) => block.type);

const mountNestedEditable = (editor: HTMLElement, contenteditable = 'true') => {
	const blockElement = editor.querySelector<HTMLElement>('[data-edytor-block]');
	if (!blockElement) {
		throw new Error('Missing block element for island mount');
	}
	const island = document.createElement('div');
	island.setAttribute('data-edytor-plugin-chrome', '');
	island.setAttribute('contenteditable', contenteditable);
	const inner = document.createElement('span');
	inner.textContent = 'island text';
	island.append(inner);
	blockElement.append(island);
	return island;
};

describe('root-level managed chrome', () => {
	test('the render anchor survives a foreign-mutation flush', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const anchor = editor.querySelector('[data-edytor-render-anchor]');
		expect(anchor, 'fixture renders the real render anchor').not.toBeNull();
		// `editor` IS the [data-edytor] root — the anchor is a direct child.
		expect(anchor?.parentElement).toBe(editor);

		// A foreign mutation forces the observer through the add/remove
		// evaluation — the anchor must not be reaped as unmanaged DOM.
		const textElement = editor.querySelector<HTMLElement>('[data-edytor-text="true"]')!;
		textElement.append(document.createElement('span'));
		await flushDomUpdates();

		expect(editor.querySelector('[data-edytor-render-anchor]')).not.toBeNull();
	});

	// R7 rewrite (R11): the root is a strict container — only its cells' block
	// elements and the core's own (registered) render anchor stay; a foreign
	// element carrying the marker is removed.
	test('a foreign element carrying the render-anchor marker under our root is removed; ours stays', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const ours = editor.querySelector('[data-edytor-render-anchor]');
		const extra = document.createElement('span');
		extra.setAttribute('data-edytor-render-anchor', '');
		editor.append(extra);
		await flushDomUpdates();
		expect(extra.isConnected).toBe(false);
		expect(ours?.isConnected).toBe(true);
	});
});

describe('link href sanitization', () => {
	test('sanitizeLinkHref allowlists safe protocols and passes scheme-less hrefs', () => {
		expect(sanitizeLinkHref('https://example.com')).toBe('https://example.com');
		expect(sanitizeLinkHref('HTTP://EXAMPLE.COM')).toBe('HTTP://EXAMPLE.COM');
		expect(sanitizeLinkHref('mailto:a@b.c')).toBe('mailto:a@b.c');
		expect(sanitizeLinkHref('tel:+123')).toBe('tel:+123');
		expect(sanitizeLinkHref('/relative/path')).toBe('/relative/path');
		expect(sanitizeLinkHref('#anchor')).toBe('#anchor');
		expect(sanitizeLinkHref('?query=1')).toBe('?query=1');
		expect(sanitizeLinkHref('//host/path')).toBe('//host/path');
	});

	test('sanitizeLinkHref rejects scriptable and malformed hrefs', () => {
		expect(sanitizeLinkHref('javascript:alert(1)')).toBeNull();
		expect(sanitizeLinkHref('JAVASCRIPT:alert(1)')).toBeNull();
		expect(sanitizeLinkHref('  javascript:alert(1)  ')).toBeNull();
		expect(sanitizeLinkHref('java\tscript:alert(1)')).toBeNull();
		expect(sanitizeLinkHref('data:text/html,<script>x</script>')).toBeNull();
		expect(sanitizeLinkHref('vbscript:msgbox(1)')).toBeNull();
		expect(sanitizeLinkHref('file:///etc/passwd')).toBeNull();
		expect(sanitizeLinkHref('')).toBeNull();
		expect(sanitizeLinkHref('   ')).toBeNull();
	});

	test('sanitizeLinkHref rejects a scheme hidden behind C0 controls or spaces (the browser strips them)', () => {
		for (let code = 0; code <= 0x20; code++) {
			const c = String.fromCharCode(code);
			expect(sanitizeLinkHref(`${c}javascript:alert(1)`), `U+${code.toString(16)}`).toBeNull();
			expect(
				sanitizeLinkHref(`javascript:alert(1)${c}`),
				`U+${code.toString(16)} after`
			).toBeNull();
		}
		expect(sanitizeLinkHref('\u0001\u001fjava\nscript:alert(1)')).toBeNull();
		expect(sanitizeLinkHref('\u0000data:text/html,x')).toBeNull();
		// What the browser would resolve the kept href to is never a script.
		for (const href of ['\u0001https://a.b/', '/p', '#a', '?q', '//host/p', 'x\u0001y']) {
			const kept = sanitizeLinkHref(href);
			if (kept !== null)
				expect(new URL(kept, 'https://base.test/').protocol).toMatch(/^(https?|mailto|tel):$/);
		}
	});

	test('native insertLink with a javascript: href stores no link mark', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|Hello|</paragraph>
			</root>
		);
		const before = JSON.stringify(edytor.value);

		const result = await dispatchDomBeforeInput(editor, {
			inputType: 'insertLink',
			data: 'javascript:alert(1)'
		});

		expect(result.defaultPrevented).toBe(true);
		expect(JSON.stringify(edytor.value)).toBe(before);
	});

	test('sanitizeCssColorValue passes real colors and rejects declaration escapes', () => {
		expect(sanitizeCssColorValue('red')).toBe('red');
		expect(sanitizeCssColorValue('#ff0000')).toBe('#ff0000');
		expect(sanitizeCssColorValue('rgb(255, 0, 0)')).toBe('rgb(255, 0, 0)');
		expect(sanitizeCssColorValue('oklch(0.7 0.1 200)')).toBe('oklch(0.7 0.1 200)');
		expect(sanitizeCssColorValue('var(--accent)')).toBe('var(--accent)');

		// `;`/`{` break out of the property position and inject whole
		// declarations — the actual style-attribute escape.
		expect(sanitizeCssColorValue('red;position:fixed;top:0')).toBeNull();
		expect(sanitizeCssColorValue('red; background: url(https://evil/x)')).toBeNull();
		expect(sanitizeCssColorValue('x{}')).toBeNull();
		expect(sanitizeCssColorValue('url(https://evil)')).toBeNull();
		expect(sanitizeCssColorValue('expression(alert(1))')).toBeNull();
		expect(sanitizeCssColorValue('red/**/;x:y')).toBeNull();
		expect(sanitizeCssColorValue('red\\;x')).toBeNull();
		expect(sanitizeCssColorValue('')).toBeNull();
		expect(sanitizeCssColorValue(42)).toBeNull();
	});

	test('a hostile color mark renders without an injected style attribute', async () => {
		const poisoned: JSONDoc = {
			children: [
				{
					type: 'paragraph',
					data: {},
					content: [
						{ text: 'safe ' },
						{ text: 'text', marks: { color: 'red;position:fixed;inset:0' } }
					]
				}
			]
		};
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>|x</paragraph>
			</root>,
			{ value: poisoned }
		);

		const styled = editor.querySelector<HTMLElement>('[data-edytor-mark="color"]');
		expect(styled, 'color mark renders a wrapper').not.toBeNull();
		const style = styled?.getAttribute('style') ?? '';
		expect(style.includes('position')).toBe(false);
		expect(style.includes('color')).toBe(false);
		expect(styled?.textContent).toBe('text');
	});

	test('formatFontColor with a hostile payload stores no mark', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|Hello|</paragraph>
			</root>
		);
		const before = JSON.stringify(edytor.value);

		const result = await dispatchDomBeforeInput(editor, {
			inputType: 'formatFontColor',
			data: 'red;position:fixed'
		});

		expect(result.defaultPrevented).toBe(true);
		expect(JSON.stringify(edytor.value)).toBe(before);
	});

	test('a javascript: link mark in the document renders without a scriptable href', async () => {
		const poisoned: JSONDoc = {
			children: [
				{
					type: 'paragraph',
					data: {},
					content: [
						{ text: 'click ' },
						{ text: 'here', marks: { link: { href: 'javascript:alert(1)' } } }
					]
				}
			]
		};
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>|x</paragraph>
			</root>,
			{ value: poisoned }
		);

		const anchor = editor.querySelector('a');
		expect(anchor, 'link mark renders an anchor').not.toBeNull();
		expect(anchor?.getAttribute('href')).toBeNull();
		expect(anchor?.textContent).toBe('here');
	});
});

describe('nested editable detection edge cases', () => {
	test('contenteditable values are matched case-insensitively', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const island = mountNestedEditable(editor, 'TRUE');
		const before = JSON.stringify(edytor.value);

		const result = await dispatchDomBeforeInput(island, {
			inputType: 'insertText',
			data: 'x'
		});

		expect(result.defaultPrevented).toBe(false);
		expect(JSON.stringify(edytor.value)).toBe(before);
	});

	test('a plaintext-only island is also foreign-owned', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const island = mountNestedEditable(editor, 'Plaintext-Only');
		const before = JSON.stringify(edytor.value);

		const result = await dispatchDomBeforeInput(island, {
			inputType: 'insertText',
			data: 'x'
		});

		expect(result.defaultPrevented).toBe(false);
		expect(JSON.stringify(edytor.value)).toBe(before);
	});

	test('a DOM selection inside an island does not move the model selection', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		);
		const island = mountNestedEditable(editor);
		const islandText = island.firstChild!.firstChild!;

		const yBefore = edytor.selection.state.yStart;
		const range = document.createRange();
		range.setStart(islandText, 2);
		range.collapse(true);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
		await flushDomUpdates();

		expect(edytor.selection.state.yStart).toBe(yBefore);
		expect(edytor.selection.state.isCollapsed).toBe(true);
	});
});

describe('removed-node chrome liveness', () => {
	test('a dismissed suggestion span is not restored', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		// Each suggestion entry is a content part: a text-run array or an
		// inline block — not a bare { text }.
		block.suggestions = [[{ text: 'maybe' }]];
		await flushDomUpdates();
		const suggestion = editor.querySelector('[data-edytor-text-suggestion]');
		expect(suggestion, 'suggestion renders').not.toBeNull();

		block.suggestions = null;
		await flushDomUpdates();
		await sleep(0);

		expect(
			editor.querySelector('[data-edytor-text-suggestion]'),
			'dismissed suggestion must stay removed — restoring it leaves a zombie Svelte never re-touches'
		).toBeNull();
	});

	test('a removed plugin-chrome host is not restored', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const blockElement = editor.querySelector<HTMLElement>('[data-edytor-block]')!;
		const host = document.createElement('span');
		host.setAttribute('data-edytor-plugin-chrome', '');
		host.setAttribute('data-test-chrome', '');
		host.contentEditable = 'false';
		blockElement.append(host);
		await flushDomUpdates();
		expect(host.isConnected, 'live chrome survives the add pass').toBe(true);

		host.remove();
		await flushDomUpdates();

		expect(
			editor.querySelector('[data-test-chrome]'),
			'plugin-owned removal must not be reverted (blockHandles cleanup relies on it)'
		).toBeNull();
	});

	test('the render anchor IS restored when removed from the root', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const anchor = editor.querySelector('[data-edytor-render-anchor]')!;
		anchor.remove();
		await flushDomUpdates();

		expect(
			editor.querySelector('[data-edytor-render-anchor]'),
			'a foreign removal of our own root-level chrome is still repaired'
		).not.toBeNull();
	});

	test('a render-anchor marker inside a text element is removed and stays removed', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const textElement = editor.querySelector<HTMLElement>('[data-edytor-text="true"]')!;
		const spoof = document.createElement('span');
		spoof.setAttribute('data-edytor-render-anchor', '');
		textElement.append(spoof);
		await flushDomUpdates();

		// The repair may remount the text element — assert against live
		// DOM, not the (now detached) element that originally held it.
		expect(
			editor.querySelector('[data-edytor-text="true"] [data-edytor-render-anchor]'),
			'chrome markers pair with specific owner kinds — render-anchor is root-only'
		).toBeNull();
	});

	test('a multi-marker data-edytor spoof loses even with a matching mark', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>
					Hello <bold>bold|</bold>
				</paragraph>
			</root>
		);
		const textElement = editor.querySelector<HTMLElement>('[data-edytor-text="true"]')!;
		const spoof = document.createElement('span');
		// Both markers present — the mark branch alone would resolve live
		// (bold is in renderChildren); the hoisted root-marker check kills it.
		spoof.setAttribute('data-edytor', '');
		spoof.setAttribute('data-edytor-mark', 'bold');
		textElement.append(spoof);
		await flushDomUpdates();

		expect(textElement.contains(spoof)).toBe(false);
	});
});

describe('placeholder scope with nested children', () => {
	test('an empty heading with non-empty children keeps its own placeholder', async () => {
		const nested: JSONDoc = {
			children: [
				{
					type: 'heading',
					data: { level: 'h1' },
					content: [{ text: '' }],
					children: [{ type: 'paragraph', data: {}, content: [{ text: 'child text' }] }]
				}
			]
		};
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>|x</paragraph>
			</root>,
			{ value: nested, placeholder: 'Type here' }
		);
		const headingElement = editor.querySelector('[data-edytor-type="heading"]');
		expect(headingElement).not.toBeNull();

		// Trigger a flush — the placeholder must survive: the child's text
		// lives in a descendant container and must not count as the
		// heading's own visible content.
		const childText = headingElement!.querySelector('[data-edytor-text="true"]');
		childText?.append(document.createElement('br'));
		await flushDomUpdates();

		const placeholder = headingElement!.querySelector(
			':scope > h1 > [data-edytor-text][data-placeholder]'
		);
		expect(
			placeholder,
			'heading keeps its own placeholder despite non-empty children'
		).not.toBeNull();
	});
});

describe('managed style healing', () => {
	test('a foreign !important declaration on an owned style is healed', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const textElement = editor.querySelector<HTMLElement>('[data-edytor-text="true"]')!;
		textElement.style.setProperty('white-space', 'pre', 'important');
		await flushDomUpdates();

		expect(textElement.style.getPropertyValue('white-space')).toBe('break-spaces');
	});
});

describe('chrome descendants', () => {
	test('content added inside an already-live plugin-chrome host survives', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const blockElement = editor.querySelector<HTMLElement>('[data-edytor-block]')!;
		const host = document.createElement('span');
		host.setAttribute('data-edytor-plugin-chrome', '');
		blockElement.append(host);
		await flushDomUpdates();
		expect(host.isConnected).toBe(true);

		const tooltip = document.createElement('b');
		tooltip.textContent = 'tip';
		host.append(tooltip);
		await flushDomUpdates();

		expect(
			host.contains(tooltip),
			'a plugin updating its own chrome after mount must not be fought'
		).toBe(true);
	});
});

describe('composition-adjacent commands', () => {
	test('input-channel historyUndo during composition is swallowed', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>abc|</paragraph>
			</root>
		);
		const before = JSON.stringify(edytor.value);

		await dispatchComposition(editor, [{ type: 'compositionstart' }]);
		expect(edytor.isComposing).toBe(true);

		await dispatchDomInput(editor, { inputType: 'historyUndo' });
		expect(JSON.stringify(edytor.value)).toBe(before);

		await dispatchComposition(editor, [{ type: 'compositionend', data: '' }]);
	});

	test('a command insert between compositionstart and commit does not drop finalValue', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>He|llo</paragraph>
			</root>
		);

		await dispatchComposition(editor, [{ type: 'compositionstart' }]);
		// A native command insert landing before the first composition
		// input must not mark the composition handled.
		await dispatchDomBeforeInput(editor, {
			inputType: 'insertHorizontalRule'
		});
		await dispatchComposition(editor, [{ type: 'compositionend', data: 'x' }]);

		const text = JSON.stringify(edytor.value);
		expect(text.includes('x'), 'the IME finalValue must still commit').toBe(true);
	});

	test('a swallowed phantom keydown does not bump the gesture serial', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>abc|</paragraph>
			</root>
		);

		await dispatchComposition(editor, [
			{ type: 'compositionstart' },
			{ type: 'compositionend', data: 'x' }
		]);

		const serialAfterCommit = gestureSerial(edytor);
		// Phantom Enter — swallowed by the composition guard, so it is not
		// a user gesture and must not disarm pending restores.
		const enter = await dispatchDomKeyDown(document, { key: 'Enter', code: 'Enter' });
		expect(enter.defaultPrevented).toBe(true);
		expect(gestureSerial(edytor)).toBe(serialAfterCommit);

		// A real key still counts as a gesture.
		await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA' });
		expect(gestureSerial(edytor)).toBeGreaterThan(serialAfterCommit);
	});
});

describe('insertHorizontalRule', () => {
	test('mid-text caret: splits the block and inserts a divider, preserving content', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>He|llo</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, { inputType: 'insertHorizontalRule' });
		expect(result.defaultPrevented).toBe(true);

		expect(blockTypes(edytor.value)).toEqual(['paragraph', 'divider', 'paragraph']);
		const texts = (edytor.value.children ?? []).map(
			(block) => block.content?.map((part) => ('text' in part ? part.text : '')).join('') ?? ''
		);
		expect(texts).toEqual(['He', '', 'llo']);
		expect(edytor.selection.state.startText?.stringContent).toBe('llo');
		expect(edytor.selection.state.yStart).toBe(0);
	});

	test('caret at block start: inserts a divider before, content intact', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|Hello</paragraph>
			</root>
		);

		await dispatchDomBeforeInput(editor, { inputType: 'insertHorizontalRule' });

		expect(blockTypes(edytor.value)).toEqual(['divider', 'paragraph']);
		expect(
			(edytor.value.children ?? [])[1].content?.map((p) => ('text' in p ? p.text : '')).join('')
		).toBe('Hello');
	});

	test('caret at block end: divider after, caret in a fresh paragraph', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		await dispatchDomBeforeInput(editor, { inputType: 'insertHorizontalRule' });

		expect(blockTypes(edytor.value)).toEqual(['paragraph', 'divider', 'paragraph']);
		expect(
			(edytor.value.children ?? [])[0].content?.map((p) => ('text' in p ? p.text : '')).join('')
		).toBe('Hello');
	});
});

describe('formatFontColor collapsed staging', () => {
	test('the staged mark inherits surrounding truthy marks', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>
					a <bold>b|b</bold>
				</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, {
			inputType: 'formatFontColor',
			data: 'rgb(255, 0, 0)'
		});
		expect(result.defaultPrevented).toBe(true);

		const staged = edytor.selection.pending;
		expect(staged?.color).toBe('rgb(255, 0, 0)');
		expect(
			staged?.bold,
			'a color command inside bold must not silently drop bold on next insert'
		).toBe(true);
	});
});
