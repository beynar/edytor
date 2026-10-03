/** @jsxImportSource ../../jsx */
/**
 * The columns plugin's rendering (docs/columns-plan.md §5, D5): a layout
 * (`columns`, `data-edytor-columns`) holds its columns in its ONE children
 * container, which `columns.css` makes a flex row; a column
 * (`data-edytor-column`) grows by its weight (`flex: <width> 1 0`, width 1
 * when missing) and holds its blocks in its own children container. The
 * read-time rules (`layout.single`, `layout.empty-item`) decide what shows:
 * a layout showing one column shows as that column's blocks. The view
 * adopts the `layout` role from the plugin, and a document that already
 * holds `layoutSemantics` accepts it. Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDocument, layoutSemantics } from '$lib/crdt/index.js';
import { columnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { renderDomEdytor } from '../../dom/test.utils.js';
import { column, columns, contractDoc, p, renderColumns, tree } from './columns.helpers.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const node = (id: string) => document.querySelector<HTMLElement>(`[data-edytor-id="${id}"]`)!;
const own = (element: Element) => element.querySelectorAll(':scope > [data-edytor-children]');

describe('a layout renders its columns side by side', () => {
	it('the layout and its columns: one children container each, columns directly in it', async () => {
		const { edytor } = await renderColumns(contractDoc());
		const layout = node('C');
		expect(layout.localName).toBe('div');
		expect(layout.hasAttribute('data-edytor-columns')).toBe(true);
		expect(own(layout)).toHaveLength(1);
		const row = own(layout)[0]!;
		expect([...row.children].map((child) => child.getAttribute('data-edytor-id'))).toEqual([
			'K1',
			'K2'
		]);
		for (const [id, kids] of [
			['K1', ['A', 'A2']],
			['K2', ['B']]
		] as const) {
			const item = node(id);
			expect(item.hasAttribute('data-edytor-column')).toBe(true);
			expect(own(item)).toHaveLength(1);
			expect(
				[...own(item)[0]!.children].map((child) => child.getAttribute('data-edytor-id'))
			).toEqual(kids);
		}
		// No other children container inside the layout's own markup.
		expect(layout.querySelectorAll('[data-edytor-children]')).toHaveLength(3);
		expect(tree(edytor)).toEqual([
			'P',
			[
				'C',
				[
					['K1', ['A', 'A2']],
					['K2', ['B']]
				]
			],
			'Z'
		]);
	});

	it('the row is a flex row with no indent; a column grows by its weight (1 when missing)', async () => {
		await renderColumns([
			columns('C', column('K1', [p('A')], 2), column('K2', [p('B')]), column('K3', [p('D')], 0.5))
		]);
		const row = own(node('C'))[0] as HTMLElement;
		expect(getComputedStyle(row).display).toBe('flex');
		expect(getComputedStyle(row).paddingInlineStart || '0px').toMatch(/^0(px)?$/);
		const grow = (id: string) => node(id).style.flexGrow;
		expect([grow('K1'), grow('K2'), grow('K3')]).toEqual(['2', '1', '0.5']);
		for (const id of ['K1', 'K2', 'K3']) {
			expect(node(id).style.flexShrink).toBe('1');
			expect(node(id).style.flexBasis).toMatch(/^0(px|%)?$/);
		}
	});

	it('from the JSX fixture: widths are data, the blocks are the columns’ own', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<columns>
					<column width={3}>
						<paragraph>left</paragraph>
					</column>
					<column width={1}>
						<paragraph>right</paragraph>
					</column>
				</columns>
			</root>,
			{ plugins: [columnsPlugin, richTextPlugin], autoSelectFixture: false }
		);
		const items = [...editor.querySelectorAll<HTMLElement>('[data-edytor-column]')];
		expect(items.map((item) => [item.style.flexGrow, item.textContent?.trim()])).toEqual([
			['3', 'left'],
			['1', 'right']
		]);
	});

	it('a layout showing one column shows as that column’s blocks (layout.single)', async () => {
		const { edytor } = await renderColumns([
			p('P'),
			columns('C', column('K1', [p('A'), p('A2')])),
			p('Z')
		]);
		expect(document.querySelector('[data-edytor-columns]')).toBeNull();
		expect(document.querySelector('[data-edytor-column]')).toBeNull();
		expect(tree(edytor)).toEqual(['P', 'A', 'A2', 'Z']);
		expect(node('A').parentElement?.closest('[data-edytor-block]')).toBeNull();
	});

	it('an empty column does not show (layout.empty-item)', async () => {
		const { edytor } = await renderColumns([
			columns('C', column('K1', [p('A')]), column('K2', []), column('K3', [p('B')]))
		]);
		const shown = [...document.querySelectorAll('[data-edytor-column]')];
		expect(shown.map((item) => item.getAttribute('data-edytor-id'))).toEqual(['K1', 'K3']);
		expect(tree(edytor)).toEqual([
			[
				'C',
				[
					['K1', ['A']],
					['K3', ['B']]
				]
			]
		]);
	});

	it('the view adopts the layout role from the plugin', async () => {
		const { edytor } = await renderColumns(contractDoc());
		expect(edytor.facade.isLayout('C')).toBe(true);
		expect(edytor.facade.isLayoutItem('K1')).toBe(true);
		expect(edytor.facade.isLayoutItem('A')).toBe(false);
	});

	it('a document holding layoutSemantics accepts a view declaring the plugin', async () => {
		const shared = createDocument({
			value: { children: contractDoc() },
			semantics: layoutSemantics
		});
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: [columnsPlugin, richTextPlugin], document: shared, autoSelectFixture: false }
		);
		expect(edytor.facade.isLayout('C')).toBe(true);
		expect(document.querySelectorAll('[data-edytor-column]')).toHaveLength(2);
	});
});
