/** @jsxImportSource ../../jsx */
/**
 * WU-31, block colours (Notion's block menu "Color"): a block's text colour
 * and background are two data leaves, `data.color` and `data.background`,
 * by palette name. The core renders a valid name on the block element
 * (`data-edytor-color`, `data-edytor-background`, owned attributes); the
 * block menu's Color flyout lists Notion's "Text color" and "Background
 * color" rows and paints the blocks it acts on (a list's items, never a
 * void or a code block) as one undo step, the blocks staying selected; Turn
 * into keeps both (`data.retype.keep`). Expected states are hand-authored
 * from Notion's menu.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { BLOCK_COLORS, colorable, setBlockColor } from '$lib/block/colors.js';
import { ownedOf } from '$lib/surface/attributes.js';
import { convertToKind } from '$lib/kinds.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const render = (children: JSONBlock[], plugins: Plugin[] = []) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [...plugins, codePlugin, richTextPlugin], value: { children } }
	);
type View = Awaited<ReturnType<typeof render>>;

const p = (id: string, data?: JSONBlock['data']): JSONBlock => ({
	id,
	type: 'paragraph',
	...(data && { data }),
	content: [{ text: id }]
});
const get = ({ edytor }: View, id: string) => edytor.idToBlock.get(id)!;
const element = (id: string) => document.querySelector(`[data-edytor-id="${id}"]`)!;
const dataOf = (view: View, id: string) => view.edytor.facade.blockDataOf(id) ?? {};
const row = (view: View, label: string) => view.edytor.kinds.find((kind) => kind.label === label)!;

const openMenu = async (view: View, id: string) => {
	const block = get(view, id);
	view.editor.dispatchEvent(
		new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
	);
	await flushDomUpdates();
};
const press = async (target: Element, events: string[] = ['mousedown', 'click']) => {
	for (const type of events)
		target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
const menuRows = () =>
	[...document.querySelectorAll('[data-testid="block-menu"] [role="menuitem"]')].map(
		(row) => row.textContent
	);
const checked = (id: string) =>
	document.querySelector(`[data-testid="block-menu-${id}"]`)?.getAttribute('aria-checked');
const flyout = () => document.querySelector('[role="menu"][aria-label="Color"]');
const openColors = async () => {
	const color = document.querySelector('[data-testid="block-menu-color"]')!;
	color.dispatchEvent(new MouseEvent('mouseenter'));
	await flushDomUpdates();
};

describe('Rendering: the palette name on the block element', () => {
	it('a text colour and a background render as owned attributes', async () => {
		const view = await render([p('a', { color: 'red' }), p('b', { background: 'blue' }), p('c')]);
		expect(element('a').getAttribute('data-edytor-color')).toBe('red');
		expect(element('a').hasAttribute('data-edytor-background')).toBe(false);
		expect(element('b').getAttribute('data-edytor-background')).toBe('blue');
		expect(element('c').hasAttribute('data-edytor-color')).toBe(false);
		// The attribute table owns them: a stripped one is foreign damage.
		const owned = ownedOf(view.edytor, element('a'), { kind: 'block', block: 'a' })!.owned;
		expect(owned['data-edytor-color']).toBe('red');
		expect(owned['data-edytor-background']).toBeNull();
	});

	it('a value that is no colour name renders nothing', async () => {
		await render([
			p('a', { color: 'red; background: url(x)' }),
			p('b', { color: 42 }),
			p('c', { background: 'Blue' })
		]);
		for (const id of ['a', 'b', 'c']) {
			expect(element(id).hasAttribute('data-edytor-color')).toBe(false);
			expect(element(id).hasAttribute('data-edytor-background')).toBe(false);
		}
	});

	it('a peer’s colour change re-renders the block', async () => {
		const view = await render([p('a')]);
		view.edytor.facade.apply(
			view.edytor.facade.prepare.patchData('a', [{ path: ['background'], value: 'yellow' }])
		);
		await flushDomUpdates();
		expect(element('a').getAttribute('data-edytor-background')).toBe('yellow');
	});
});

describe('setBlockColor: one command, one undo step', () => {
	it('paints every colourable block, and undo takes it back at once', async () => {
		const view = await render([p('a'), p('b'), p('c')]);
		expect(setBlockColor(view.edytor, [get(view, 'a'), get(view, 'b')], 'color', 'green')).toBe(
			true
		);
		await flushDomUpdates();
		expect(dataOf(view, 'a')).toEqual({ color: 'green' });
		expect(dataOf(view, 'b')).toEqual({ color: 'green' });
		expect(dataOf(view, 'c')).toEqual({});
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(dataOf(view, 'a')).toEqual({});
		expect(dataOf(view, 'b')).toEqual({});
	});

	it('null removes the colour (Default); an unknown name is refused', async () => {
		const view = await render([p('a', { color: 'red', background: 'gray' })]);
		expect(setBlockColor(view.edytor, [get(view, 'a')], 'color', null)).toBe(true);
		expect(dataOf(view, 'a')).toEqual({ background: 'gray' });
		expect(setBlockColor(view.edytor, [get(view, 'a')], 'background', 'red;x')).toBe(false);
		expect(dataOf(view, 'a')).toEqual({ background: 'gray' });
	});

	it('a divider, a code block and its lines take no colour', async () => {
		const view = await render([
			p('a'),
			{ id: 'd', type: 'divider' },
			{ id: 'k', type: 'code', children: [{ id: 'l', type: 'codeLine', content: [{ text: 'x' }] }] }
		]);
		expect(['a', 'd', 'k', 'l'].map((id) => colorable(get(view, id)))).toEqual([
			true,
			false,
			false,
			false
		]);
		expect(
			setBlockColor(
				view.edytor,
				['d', 'k', 'l'].map((id) => get(view, id)),
				'background',
				'red'
			)
		).toBe(false);
	});

	it('a readonly view paints nothing', async () => {
		const view = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: [richTextPlugin], readonly: true, value: { children: [p('a')] } }
		);
		setBlockColor(view.edytor, [get(view, 'a')], 'color', 'red');
		expect(view.edytor.facade.blockDataOf('a') ?? {}).toEqual({});
	});
});

describe('The block menu’s Color flyout (Notion)', () => {
	it('Color sits after Turn into and opens Notion’s two sections', async () => {
		const view = await render([p('a'), p('b')], [blockMenuPlugin]);
		await openMenu(view, 'a');
		expect(menuRows().slice(0, 2)).toEqual(['Turn into', 'Color']);
		await openColors();
		const menu = flyout()!;
		expect(menu).not.toBeNull();
		const headings = [...menu.querySelectorAll('.block-menu-heading')].map((h) => h.textContent);
		expect(headings.map((h) => h?.trim())).toEqual(['Text color', 'Background color']);
		const labels = [...menu.querySelectorAll('[role="menuitemradio"]')].map((r) => r.textContent);
		const names = ['Default', 'Gray', 'Brown', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple'];
		expect(labels).toEqual([
			...[...names, 'Pink', 'Red'].map((name) => `${name} text`),
			...[...names, 'Pink', 'Red'].map((name) => `${name} background`)
		]);
		expect(BLOCK_COLORS).toHaveLength(9);
		// Nothing painted yet: the defaults are the current rows.
		expect(checked('color.default')).toBe('true');
	});

	it('a pick paints the block, closes the menu and keeps it selected; undo restores', async () => {
		const view = await render([p('a'), p('b')], [blockMenuPlugin]);
		await openMenu(view, 'a');
		await openColors();
		await press(document.querySelector('[data-testid="block-menu-background.blue"]')!);
		expect(dataOf(view, 'a')).toEqual({ background: 'blue' });
		expect(element('a').getAttribute('data-edytor-background')).toBe('blue');
		expect(document.querySelector('[data-testid="block-menu"]')).toBeNull();
		expect(view.edytor.selection.value).toEqual({ kind: 'blocks', ids: ['a'] });
		// The ✓ follows the block's colour.
		await openMenu(view, 'a');
		await openColors();
		expect(checked('background.blue')).toBe('true');
		expect(checked('background.default')).toBe('false');
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(dataOf(view, 'a')).toEqual({});
	});

	it('the keyboard: → opens the flyout from Color, ↓ walks it, Enter paints', async () => {
		const view = await render([p('a')], [blockMenuPlugin]);
		await openMenu(view, 'a');
		const field = document.querySelector<HTMLInputElement>('[data-testid="block-menu"] input')!;
		const key = async (key: string) => {
			field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
			await flushDomUpdates();
		};
		await key('ArrowDown'); // Turn into → Color
		await key('ArrowRight');
		expect(flyout()).not.toBeNull();
		await key('ArrowDown'); // Default text → Gray text
		await key('Enter');
		expect(dataOf(view, 'a')).toEqual({ color: 'gray' });
	});

	it('over a block selection holding a list, its items are painted, never the list', async () => {
		const view = await render(
			[
				p('a'),
				{
					id: 'u',
					type: 'unordered-list',
					children: [
						{ id: 'i1', type: 'list-item', content: [{ text: 'one' }] },
						{ id: 'i2', type: 'list-item', content: [{ text: 'two' }] }
					]
				}
			],
			[blockMenuPlugin]
		);
		view.edytor.selection.selectBlocks(get(view, 'a'), get(view, 'u'));
		await flushDomUpdates();
		await openMenu(view, 'a');
		await openColors();
		await press(document.querySelector('[data-testid="block-menu-color.red"]')!);
		expect(['a', 'u', 'i1', 'i2'].map((id) => dataOf(view, id).color)).toEqual([
			'red',
			undefined,
			'red',
			'red'
		]);
		// One undo step for the whole pick.
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(['a', 'i1', 'i2'].map((id) => dataOf(view, id).color)).toEqual([
			undefined,
			undefined,
			undefined
		]);
	});

	it('no Color row over a divider alone', async () => {
		const view = await render([{ id: 'd', type: 'divider' }, p('a')], [blockMenuPlugin]);
		await openMenu(view, 'd');
		expect(menuRows()).not.toContain('Color');
	});
});

describe('Turn into keeps the colours (data.retype.keep)', () => {
	it('a red paragraph on a yellow background turned into a heading, then a toggle heading', async () => {
		const view = await render([p('a', { color: 'red', background: 'yellow' })]);
		expect(convertToKind(view.edytor, get(view, 'a'), row(view, 'Heading 2'))).toBe(true);
		await flushDomUpdates();
		expect(dataOf(view, 'a')).toEqual({ color: 'red', background: 'yellow', level: 'h2' });
		expect(element('a').getAttribute('data-edytor-color')).toBe('red');
		expect(convertToKind(view.edytor, get(view, 'a'), row(view, 'Toggle heading 2'))).toBe(true);
		await flushDomUpdates();
		expect(view.edytor.value.children![0]!.type).toBe('toggle-heading');
		expect(element('a').getAttribute('data-edytor-background')).toBe('yellow');
	});
});
