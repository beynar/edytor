<script module lang="ts">
	import './columns.css';
	import type { BlockSnippetPayload, BlockView, EditorCommand, Plugin } from '$lib/plugins.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import { layoutKinds } from '$lib/crdt/semantics.js';
	import { convertToKind, wrapBlocks, wrappable, type KindRow } from '$lib/kinds.js';
	import {
		getSelectedBlocksInDocumentOrder,
		liftLayouts
	} from '$lib/selection/replaceSelection.js';
	import ColumnResizeStrips from './ColumnResize.svelte';
	import { ColumnResize, weightOf } from './resize.svelte.js';

	export type ColumnsPluginOptions = {
		/**
		 * The narrowest a column may be resized to, as a fraction of its layout's
		 * width (default `0.1`). View-only: the document stores weights.
		 */
		minWidth?: number;
	};

	const columnsPlugins = new WeakSet<Plugin>();

	/** Recognize any columns plugin instance (the component's default yields to yours). */
	export const isColumnsPlugin = (plugin: Plugin) => columnsPlugins.has(plugin);

	/** A weight read back from HTML (`data-width`), when it is one. */
	const parsedWidth = (element: HTMLElement): Record<string, number> => {
		const width = Number(element.getAttribute('data-width'));
		return Number.isFinite(width) && width > 0 ? { width } : {};
	};

	/**
	 * Whether `block` sits in a layout's column, at any depth: no layout goes
	 * there (D2, `layout.nest`). A `+` menu's stand-in (no id yet) answers by
	 * its parents.
	 */
	const inColumn = (block: Block | null | undefined) => {
		for (let at = block; at && !at.isRoot; at = at.parent)
			if (at.id && at.edytor.facade.isLayoutItem(at.id)) return true;
		return false;
	};

	/** The kind row of a layout of `n` columns, each holding one empty block of the column's default kind. */
	const layoutRow = (edytor: Edytor, n: number): KindRow => {
		const kid = edytor.document.defaultChild('column');
		return {
			id: `columns.${n}`,
			label: `${n} columns`,
			group: 'Layout',
			// Notion's `/col3`, `/columns3` too.
			keywords: ['columns', 'layout', 'side by side', `col${n}`, `columns${n}`],
			value: {
				type: 'columns',
				data: {},
				content: [],
				children: Array.from({ length: n }, () => ({
					type: 'column',
					data: {},
					children: [{ type: kid, content: [] }]
				}))
			},
			replaces: true
		};
	};

	/**
	 * `columns.<n>`: a layout of `n` columns, each holding an empty paragraph,
	 * the caret in the first; it replaces an empty line (a slash line holding
	 * only its query) and is inserted after any other (`convertToKind`), one
	 * undo step. Disabled, and refused, inside a column (D2). Over a block
	 * selection of `n` sibling blocks (the block menu's Turn into, `turnsInto`)
	 * it wraps them instead, one per column, and over one block it makes that
	 * block column 1 of `n`, each other column holding an empty paragraph
	 * (`wrapBlocks`, `layout.wrap`, Notion); the blocks stay selected.
	 */
	const layoutCommand = (edytor: Edytor, n: number): EditorCommand => {
		const { id, label, group, keywords } = layoutRow(edytor, n);
		return {
			id,
			label,
			group,
			keywords,
			// Asked of the view given (a `+`'s menu asks it of the block it adds).
			isEnabled: (view = edytor) => {
				const block = view.selection.state.startBlock;
				return Boolean(block?.convertible) && !inColumn(block);
			},
			// Turn into: one block, or `n` sibling blocks, in `n` columns (`layout.wrap`, Notion).
			turnsInto: (blocks) =>
				(blocks.length === 1 || blocks.length === n) && wrappable(edytor, blocks, 'columns', n),
			run: () => {
				const selected = getSelectedBlocksInDocumentOrder(edytor);
				if (
					edytor.selection.value.kind === 'blocks' &&
					(selected.length === 1 || selected.length === n)
				)
					return wrapBlocks(edytor, selected, 'columns', n);
				const block = edytor.selection.state.startBlock;
				if (inColumn(block)) {
					edytor.dispatcher.last = { operation: 'setBlock', status: 'refused' };
					return false;
				}
				return convertToKind(edytor, block, layoutRow(edytor, n));
			}
		};
	};

	/**
	 * Whether the block selection stands for this layout (D3: it covers every
	 * shown block of every column, or holds the layout): its highlight covers
	 * the whole layout. Reads the cells, so a peer's change re-renders it.
	 */
	const standsFor = (view: BlockView) => {
		const layout = view.handle;
		if (!layout) return false;
		const { selection, cells } = layout.edytor;
		for (const item of cells?.get(layout.id)?.childIds ?? []) void cells?.get(item)?.childIds;
		if (!selection.selectedBlocks.size) return false;
		return liftLayouts(selection.selectedBlocks).some((block) => block.id === layout.id);
	};

	/**
	 * Notion's columns (docs/columns-plan.md): a `columns` layout shows its
	 * `column`s side by side, each holding any blocks; a column grows by its
	 * weight (`data.width`). The roles are the document's (`layoutKinds`,
	 * `layout.*` in the delete contract): a layout showing one column shows
	 * as its blocks, an empty column does not show. `columns.css` lays them
	 * out and stacks them below a 480px wide layout.
	 */
	export const createColumnsPlugin = (options: ColumnsPluginOptions = {}): Plugin => {
		const plugin: Plugin = (edytor) => {
			const resize = new ColumnResize(edytor, options.minWidth ?? 0.1);
			return {
				commands: [2, 3, 4, 5].map((n) => layoutCommand(edytor, n)),
				// The resize strips: in the overlay, for the layout under the pointer.
				onEdytorAttached: ({ node }) => {
					const over = (event: PointerEvent) => resize.hover(event.target);
					const leave = (event: PointerEvent) => resize.leave(event.relatedTarget);
					// A block drag owns the pointer: no strip takes it meanwhile.
					const drag = (event: Event) => (resize.dragging = event.type === 'dragstart');
					const document = node.ownerDocument;
					node.addEventListener('pointerover', over);
					node.addEventListener('pointerleave', leave);
					document.addEventListener('dragstart', drag, true);
					document.addEventListener('dragend', drag, true);
					document.addEventListener('drop', drag, true);
					const unmount = edytor.overlay.mount(
						ColumnResizeStrips,
						{ resize },
						'edytor-column-resizers',
						4,
						resize.measure
					);
					return () => {
						node.removeEventListener('pointerover', over);
						node.removeEventListener('pointerleave', leave);
						document.removeEventListener('dragstart', drag, true);
						document.removeEventListener('dragend', drag, true);
						document.removeEventListener('drop', drag, true);
						unmount();
					};
				},
				blocks: {
					columns: {
						...layoutKinds.columns,
						snippet: columns,
						element: { tag: 'div', attributes: { 'data-edytor-columns': '' } },
						html: (_, __, children) => `<div data-edytor-columns>${children}</div>`,
						plain: (_, __, children) => children,
						parse: (element) => (element.hasAttribute('data-edytor-columns') ? {} : undefined)
					},
					column: {
						...layoutKinds.column,
						snippet: column,
						// Its weight as shown: a resize drag's preview (this view only), else `data.width`.
						element: (data, id) => ({
							tag: 'div',
							attributes: {
								'data-edytor-column': '',
								style: `flex: ${resize.weight(id, data)} 1 0px`
							}
						}),
						html: (block, _, children) =>
							`<div data-edytor-column data-width="${weightOf(block.data)}">${children}</div>`,
						plain: (_, __, children) => children,
						parse: (element) =>
							element.hasAttribute('data-edytor-column') ? parsedWidth(element) : undefined
					}
				}
			};
		};
		columnsPlugins.add(plugin);
		return plugin;
	};

	/** Columns with the default options. */
	export const columnsPlugin = createColumnsPlugin();
</script>

<!--
	The layout's columns, in its one children container (a flex row,
	`columns.css`); `data-edytor-columns-selected` while a block selection
	stands for the layout (D3).
-->
{#snippet columns({ block, children }: BlockSnippetPayload)}
	{#if children}
		<div data-edytor-children data-edytor-columns-selected={standsFor(block) ? 'true' : undefined}>
			{@render children()}
		</div>
	{/if}
{/snippet}

<!-- A column's blocks, in its own children container (not indented). -->
{#snippet column({ children }: BlockSnippetPayload)}
	{#if children}
		<div data-edytor-children>
			{@render children()}
		</div>
	{/if}
{/snippet}
