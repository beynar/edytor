<script module lang="ts">
	import { DEV } from 'esm-env';
	import { UNKNOWN_KIND, type Edytor } from '../edytor.svelte.js';
	import type { Block as BlockHandle } from '../block/block.svelte.js';
	import type { BlockDefinition, BlockView } from '../plugins.js';

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
				return edytor.cells?.get(id)?.data ?? {};
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

	/** Tags that take no content: the kind renders the element only. */
	const VOID_TAGS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'wbr']);

	/** The element a kind declares (O45): a tag, or tag and attributes, from the block's data. */
	const elementOf = (definition: BlockDefinition, data: Record<string, unknown> | undefined) => {
		const spec =
			typeof definition.element === 'function'
				? definition.element(data ?? {})
				: (definition.element ?? 'div');
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

	let {
		id
	}: {
		id: string;
	} = $props();

	const edytor = getContext<Edytor>('edytor');
	// The structure renders from the cell (R2); the snippet receives a view object (R4).
	const cell = $derived(edytor.cells?.get(id));
	const block = $derived(blockViewOf(edytor, id));
	const definition = $derived(cell && edytor.definitionOf(cell.type));
	// The core renders the block element from the definition; the snippet renders inside it (R11).
	const element = $derived(definition && elementOf(definition, cell?.data));
	/** Registers the block element (O45): one element per block, re-registered when the tag changes. */
	const register = (node: HTMLElement) => block.handle.attach(node);

	// The kind `content()` last rendered under — read after each render.
	let contentRenderedFor: string | undefined;
	$effect(() => {
		if (DEV) checkRendersContent(block.handle, contentRenderedFor === cell?.type);
	});
</script>

<!--
-->{#snippet content()}<!--
--><Content
		{id}
		onrender={DEV ? () => (contentRenderedFor = cell?.type) : undefined}
	/><!--
-->{/snippet}<!--
-->{#snippet children()}<!--
--->{#each cell?.childIds ?? [] as child (child)}<!--
--><Child
			id={child}
		/><!--
-->{/each}<!--
-->{/snippet}<!--
-->{#if cell && definition && element}<!--
--><svelte:element
		this={element.tag}
		{...element.attributes}
		data-edytor-block="true"
		data-edytor-id={id}
		data-edytor-type={cell.type}
		data-edytor-void={definition.void ? 'true' : undefined}
		data-edytor-selected={edytor.selection.selectedBlocks.has(edytor.idToBlock.block(id))
			? 'true'
			: undefined}
		data-edytor-focused={edytor.selection.focusedBlocks.has(edytor.idToBlock.block(id))
			? 'true'
			: undefined}
		contenteditable={definition.void ? 'false' : undefined}
		style:user-select={definition.void ? 'none' : undefined}
		use:register
		><!--
	-->{#if definition.snippet && !VOID_TAGS.has(element.tag)}<!--
	-->{@render definition.snippet(
				{
					block,
					content,
					children: cell.childIds.length ? children : null
				}
			)}<!--
	-->{:else if definition === UNKNOWN_KIND}<!--
		A kind this view does not register: a plain block, its text and children.
	-->{@render content()}{@render children()}<!--
	-->{/if}<!--
--></svelte:element
	><!--
-->{/if}<!--
-->
