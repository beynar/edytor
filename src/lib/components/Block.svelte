<script module lang="ts">
	import { DEV } from 'esm-env';
	import type { Edytor } from '../edytor.svelte.js';
	import { UNKNOWN_KIND } from '../kinds.js';
	import { voidChrome, type Block as BlockHandle } from '../block/block.svelte.js';
	import type { BlockDefinition, BlockView } from '../plugins.js';
	import type { PreviewCell } from '../surface/cells.js';
	import { replacedMark } from '../session/suggestions.svelte.js';

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

	/**
	 * The element a kind declares (O45): a tag, or tag and attributes, from the
	 * block's data and id (a kind's own view state keyed by block, such as a
	 * column's width while a resize drags; reactive state the function reads
	 * re-renders the element).
	 */
	const elementOf = (
		declared: BlockDefinition['element'],
		data: Record<string, unknown> | undefined,
		id: string
	) => {
		const spec = typeof declared === 'function' ? declared(data ?? {}, id) : declared;
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
	import { blockDir, ownText } from '../surface/attributes.js';
	import { colorAttributes } from '../block/colors.js';

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
	const element = $derived(definition && elementOf(definition.element ?? 'div', cell?.data, id));
	// The element around the block's own text (a heading's `h2`): the core's, so an override keeps it.
	const contentElement = $derived(
		definition && elementOf(definition.contentElement, cell?.data, id)
	);
	/** Its direction from its own text (`blockDir`, bidi): none in a preview. */
	const dir = $derived(preview ? null : blockDir(ownText(cell?.runs ?? [])));
	/**
	 * `dir` as an attribute, absent when `null`: Svelte writes `dir` as a
	 * property, which would leave `dir=""` where the table wants none.
	 */
	const direction = (node: HTMLElement, value: 'rtl' | 'ltr' | null) => {
		const write = (next: 'rtl' | 'ltr' | null) =>
			next ? node.setAttribute('dir', next) : node.removeAttribute('dir');
		write(value);
		return { update: write };
	};
	/** Registers the block element (O45): one element per block, re-registered when the tag changes. */
	const register = (node: HTMLElement) => block.handle?.attach(node);
	/** The block element's attributes: the kind's, then the core's. */
	const attributes = $derived(
		element && {
			...element.attributes,
			// Its colour and background by palette name (`block/colors.ts`).
			...colorAttributes(cell?.data),
			'data-edytor-block': 'true',
			'data-edytor-id': preview ? undefined : id,
			'data-edytor-type': cell?.type,
			'data-edytor-void': definition?.void ? 'true' : undefined,
			'data-edytor-selected':
				block.handle && edytor.selection.selectedBlocks.has(block.handle) ? 'true' : undefined,
			'data-edytor-focused':
				block.handle && edytor.selection.focusedBlocks.has(block.handle) ? 'true' : undefined,
			'data-edytor-suggestion-replaced': shown ? (replacedMark(shown) ?? undefined) : undefined,
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
			use:direction={dir}
		/><!--
-->{:else}<!--
--><svelte:element
			this={element.tag}
			{...attributes}
			style:user-select={definition.void ? 'none' : undefined}
			use:register
			use:direction={dir}
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
	/*
	 * Block colours (`block/colors.ts`): Notion's palette by name, each a
	 * theme token with Notion's light value as its fallback. The text colour
	 * and the background reach the block's children, as in Notion; a mark's
	 * own colour inside wins.
	 */
	:global([data-edytor-block][data-edytor-color='gray']) {
		color: var(--edytor-color-gray, #7d7a75);
	}
	:global([data-edytor-block][data-edytor-color='brown']) {
		color: var(--edytor-color-brown, #9f765a);
	}
	:global([data-edytor-block][data-edytor-color='orange']) {
		color: var(--edytor-color-orange, #d27b2d);
	}
	:global([data-edytor-block][data-edytor-color='yellow']) {
		color: var(--edytor-color-yellow, #cb9434);
	}
	:global([data-edytor-block][data-edytor-color='green']) {
		color: var(--edytor-color-green, #50946e);
	}
	:global([data-edytor-block][data-edytor-color='blue']) {
		color: var(--edytor-color-blue, #387dc9);
	}
	:global([data-edytor-block][data-edytor-color='purple']) {
		color: var(--edytor-color-purple, #9a6bb4);
	}
	:global([data-edytor-block][data-edytor-color='pink']) {
		color: var(--edytor-color-pink, #c14c8a);
	}
	:global([data-edytor-block][data-edytor-color='red']) {
		color: var(--edytor-color-red, #cf5148);
	}
	:global([data-edytor-block][data-edytor-background='gray']) {
		background-color: var(--edytor-background-gray, #f0efed);
	}
	:global([data-edytor-block][data-edytor-background='brown']) {
		background-color: var(--edytor-background-brown, #f5ede9);
	}
	:global([data-edytor-block][data-edytor-background='orange']) {
		background-color: var(--edytor-background-orange, #fbebde);
	}
	:global([data-edytor-block][data-edytor-background='yellow']) {
		background-color: var(--edytor-background-yellow, #f9f3dc);
	}
	:global([data-edytor-block][data-edytor-background='green']) {
		background-color: var(--edytor-background-green, #e8f1ec);
	}
	:global([data-edytor-block][data-edytor-background='blue']) {
		background-color: var(--edytor-background-blue, #e5f2fc);
	}
	:global([data-edytor-block][data-edytor-background='purple']) {
		background-color: var(--edytor-background-purple, #f3ebf9);
	}
	:global([data-edytor-block][data-edytor-background='pink']) {
		background-color: var(--edytor-background-pink, #fae9f1);
	}
	:global([data-edytor-block][data-edytor-background='red']) {
		background-color: var(--edytor-background-red, #fce9e7);
	}
	/*
	 * An empty line a suggestion replaces (Ask AI on an empty line): the
	 * preview right after it stands in its place. It stays mounted, folded,
	 * so the caret it holds stays valid; typing in it unfolds it.
	 */
	:global([data-edytor-suggestion-replaced='empty']) {
		/* Over any theme's block spacing. */
		height: 0 !important;
		min-height: 0 !important;
		margin-block: 0 !important;
		padding-block: 0 !important;
		border-block-width: 0 !important;
		overflow: hidden;
	}
</style>
