<script module lang="ts">
	import { DEV } from 'esm-env';
	import { UNKNOWN_KIND, type Edytor } from '../edytor.svelte.js';
	import { voidChrome, type Block as BlockHandle } from '../block/block.svelte.js';
	import type { BlockDefinition, BlockView } from '../plugins.js';
	import type { PreviewCell } from '../surface/cells.js';

	const reported = new WeakMap<Edytor, Set<string>>();

	/** A snippet's view object (R4): declared values read from the cell and the selection. */
	const blockViewOf = (edytor: Edytor, id: string): BlockView => {
		const handle = edytor.idToBlock.block(id);
		return {
			id,
			get type() {
				return edytor.cells?.get(id)?.type ?? handle.type;
			},
			get data() {
				return handle.data;
			},
			get selected() {
				return handle.selected;
			},
			get focused() {
				return handle.focused;
			},
			handle,
			void: handle.void
		};
	};

	/** A suggestion's block (`preview`): its declared values, no handle, never selected. */
	const previewViewOf = (cell: PreviewCell): BlockView => ({
		id: cell.id,
		type: cell.type,
		data: cell.data ?? {},
		selected: false,
		focused: false,
		handle: undefined,
		void: voidChrome
	});

	/** Tags that take no content: the kind renders the element only. */
	const VOID_TAGS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'wbr']);

	/** The element a kind declares (O45): a tag, or tag and attributes, from the block's data. */
	const elementOf = (
		declared: BlockDefinition['element'],
		data: Record<string, unknown> | undefined
	) => {
		const spec = typeof declared === 'function' ? declared(data ?? {}) : declared;
		if (spec === undefined) return undefined;
		return typeof spec === 'string' ? { tag: spec, attributes: {} } : { attributes: {}, ...spec };
	};

	/**
	 * Dev check of the declared `rendersContent` (O22, F-S14): a kind whose
	 * snippet rendered `content()` against its declaration is reported once
	 * per editor — an undeclared phantom slot would take carets and endpoints
	 * the user cannot see.
	 */
	const checkRendersContent = (block: BlockHandle, rendered: boolean) => {
		const kinds = reported.get(block.edytor) ?? new Set<string>();
		if (block.rendersContent === rendered || kinds.has(block.type)) return;
		reported.set(block.edytor, kinds.add(block.type));
		console.warn(
			`[edytor] block kind "${block.type}" declares rendersContent: ${!rendered} but its ` +
				`snippet ${rendered ? 'renders' : 'does not render'} content().`
		);
	};
</script>

<script lang="ts">
	import { getContext } from 'svelte';
	import Child from './Block.svelte';
	import Content from './Content.svelte';
	import Suggestion from './Suggestion.svelte';

	let {
		id,
		preview
	}: {
		id: string;
		/** A suggestion's block: rendered from its preview cell, never registered (`Suggestion`). */
		preview?: PreviewCell;
	} = $props();

	const edytor = getContext<Edytor>('edytor');
	// The structure renders from the cell (R2); the snippet receives a view object (R4).
	const cell = $derived(preview ?? edytor.cells?.get(id));
	const block = $derived(preview ? previewViewOf(preview) : blockViewOf(edytor, id));
	/** The suggestions shown before, after and inside this block (none in a preview). */
	const shown = $derived(preview ? null : edytor.suggestions.at(id));
	/** The children: a preview's own, else the cell's ids. */
	const kids = $derived(
		preview
			? preview.children
			: (edytor.cells?.get(id)?.childIds ?? []).map((child) => ({ id: child }))
	);
	const definition = $derived(cell && edytor.definitionOf(cell.type));
	// The core renders the block element from the definition; the snippet renders inside it (R11).
	const element = $derived(definition && elementOf(definition.element ?? 'div', cell?.data));
	// The element around the block's own text (a heading's `h2`): the core's, so an override keeps it.
	const contentElement = $derived(definition && elementOf(definition.contentElement, cell?.data));
	/** Registers the block element (O45): one element per block, re-registered when the tag changes. */
	const register = (node: HTMLElement) => block.handle?.attach(node);
	/** The block element's attributes: the kind's, then the core's. */
	const attributes = $derived(
		element && {
			...element.attributes,
			'data-edytor-block': 'true',
			'data-edytor-id': preview ? undefined : id,
			'data-edytor-type': cell?.type,
			'data-edytor-void': definition?.void ? 'true' : undefined,
			'data-edytor-selected':
				block.handle && edytor.selection.selectedBlocks.has(block.handle) ? 'true' : undefined,
			'data-edytor-focused':
				block.handle && edytor.selection.focusedBlocks.has(block.handle) ? 'true' : undefined,
			'data-edytor-suggestion-replaced': shown?.replaced ? '' : undefined,
			contenteditable: definition?.void ? ('false' as const) : undefined
		}
	);

	// The kind `content()` last rendered under — read after each render.
	let contentRenderedFor: string | undefined;
	$effect(() => {
		if (DEV && block.handle) checkRendersContent(block.handle, contentRenderedFor === cell?.type);
	});
</script>

<!--
-->{#snippet text()}<!--
--><Content
		{id}
		preview={preview?.runs}
		onrender={DEV ? () => (contentRenderedFor = cell?.type) : undefined}
	/><!--
-->{/snippet}<!--
-->{#snippet content()}<!--
-->{#if contentElement}<!--
--><svelte:element
			this={contentElement.tag}
			{...contentElement.attributes}>{@render text()}</svelte:element
		><!--
-->{:else}<!--
-->{@render text()}<!--
-->{/if}<!--
-->{/snippet}<!--
-->{#snippet children()}<!--
--->{#each kids as child (child.id)}<!--
--><Child
			id={child.id}
			preview={preview && (child as PreviewCell)}
		/><!--
-->{/each}<!--
-->{#each shown?.inside ?? [] as suggestion (suggestion.id)}<!--
--><Suggestion
			{suggestion}
		/><!--
-->{/each}<!--
-->{/snippet}<!--
-->{#each shown?.before ?? [] as suggestion (suggestion.id)}<!--
--><Suggestion
		{suggestion}
	/><!--
-->{/each}<!--
-->{#if cell && definition && element}<!--
	A void tag (a divider's `hr`) takes no body: the element alone.
-->{#if VOID_TAGS.has(element.tag)}<!--
--><svelte:element
			this={element.tag}
			{...attributes}
			style:user-select={definition.void ? 'none' : undefined}
			use:register
		/><!--
-->{:else}<!--
--><svelte:element
			this={element.tag}
			{...attributes}
			style:user-select={definition.void ? 'none' : undefined}
			use:register
			><!--
		-->{#if definition.snippet}<!--
		-->{@render definition.snippet({
					block,
					content,
					children: kids.length || shown?.inside.length ? children : null
				})}<!--
		-->{:else if definition === UNKNOWN_KIND}<!--
			A kind this view does not register: a plain block, its text and children.
		-->{@render content()}{#if kids.length || shown?.inside.length}<div
						data-edytor-children
					>
						{@render children()}
					</div>{/if}<!--
		-->{/if}<!--
	--></svelte:element
		><!--
-->{/if}<!--
-->{/if}<!--
-->{#each shown?.after ?? [] as suggestion (suggestion.id)}<!--
--><Suggestion
		{suggestion}
	/><!--
-->{/each}

<!--
-->

<style>
	/*
	 * One nesting step (Notion's 24px): a kind's snippet renders its children
	 * in one `data-edytor-children` container, indented here, so a block
	 * nested under any kind sits one step in. A theme whose kind indents its
	 * children another way (a list's marker column) sets its own padding.
	 */
	:global([data-edytor-children]) {
		padding-inline-start: var(--edytor-nest-indent, 24px);
	}
</style>
