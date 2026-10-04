<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import { Text } from '$lib/text/text.svelte.js';
	import type { Snippet } from 'svelte';
	import BlockHandle from './BlockHandle.svelte';
	import type { BlockHandleSnippetPayload } from './blockHandlesPlugin.js';
	import type { BlockHandleController } from './BlockHandleController.svelte.js';
	import { gapBefore } from '../columns/gaps.js';

	/**
	 * The handles, in the overlay (R11): one per registered movable block that
	 * is near the viewport, hovered, selected, focused or dragged, in document
	 * order, each beside its block's first text row (the header row for an
	 * island), measured by the overlay once per frame.
	 */
	let {
		edytor,
		controller,
		blocks,
		near,
		hovered,
		handle
	}: {
		edytor: Edytor;
		controller: BlockHandleController;
		/** Registered movable blocks, by id (`onBlockAttached`); reactive. */
		blocks: ReadonlyMap<string, Block>;
		/** Blocks near the viewport; reactive. */
		near: ReadonlySet<string>;
		/** Blocks under the pointer; reactive. */
		hovered: ReadonlySet<string>;
		/** A custom handle (`BlockHandlesOptions.handle`). */
		handle?: Snippet<[BlockHandleSnippetPayload]>;
	} = $props();

	/** The block whose handle holds focus: its handle stays while focused. */
	let focused = $state<string | null>(null);

	/** Bumped by commits that change the tree: the handles' order follows it. */
	let structure = $state(0);
	onMount(() =>
		edytor.facade.onChange((change) => {
			if (change.order.size || change.added.size || change.removed.size) structure++;
		})
	);
	const ids = $derived.by(() => {
		void structure;
		const selected = edytor.selection.selectedBlocks;
		return edytor.facade
			.order()
			.filter(
				(id) =>
					blocks.has(id) &&
					(near.has(id) ||
						hovered.has(id) ||
						id === focused ||
						id === controller.dragging ||
						selected.has(blocks.get(id)!))
			);
	});

	/** The blocks whose handle sits over a gap between two columns (`overGap`, measured). */
	const overGaps = new SvelteSet<string>();

	/**
	 * The gap left of `block`'s column when its handle sits over it: `block`
	 * is directly in a layout's column with a column beside it on its left
	 * (`gapBefore`, the measurement the resize band shares). Column 1's
	 * handle sits in the editor's gutter, over no gap, as a root block's.
	 */
	const overGap = (block: Block) => {
		const column = block.parent;
		if (!column?.node || column.isRoot || !edytor.facade.isLayoutItem(column.id)) return null;
		return gapBefore(column);
	};

	/** Where a block's own row ends: where its first shown child begins, else its box's bottom. */
	const ownRowBottom = (node: HTMLElement, rect: DOMRect) => {
		const child = node
			.querySelector<HTMLElement>('[data-edytor-block="true"]')
			?.getBoundingClientRect();
		return child && child.height > 0 && child.top >= rect.top && child.top < rect.bottom
			? child.top
			: rect.bottom;
	};

	const firstRowCenter = (node: HTMLElement, block: Block): number => {
		if (block.definition.island) {
			const header = node.querySelector<HTMLElement>(':scope > [data-edytor-void="true"]');
			const rect = header?.getBoundingClientRect();
			if (rect) return rect.top + rect.height / 2;
		}
		if (!block.definition.void && !block.definition.island) {
			const text = block.content.find((part): part is Text => part instanceof Text);
			const line = text?.node?.getClientRects()[0];
			if (line && line.height > 0) return line.top + line.height / 2;
		}
		const rect = node.getBoundingClientRect();
		return rect.top + Math.min(rect.height, 24) / 2;
	};

	/** Beside its block's first row; hidden with it; off-screen blocks keep their last place. */
	const place = (host: HTMLElement, id: string) => {
		let at = '';
		// Unplaced, a handle would show at the layer's origin for a frame.
		host.style.visibility = 'hidden';
		const margin = () => host.ownerDocument.defaultView?.innerHeight ?? 0;
		const off = edytor.overlay.add((origin) => {
			const block = blocks.get(id);
			const node = block?.node;
			if (!block || !node?.isConnected) return;
			const rect = node.getBoundingClientRect();
			const shown = rect.width > 0 || rect.height > 0;
			if (at && shown && (rect.bottom < -margin() || rect.top > 2 * margin())) return;
			const center = shown ? firstRowCenter(node, block) : 0;
			const left = `${rect.left - origin.left}px`;
			const top = shown ? `${center - origin.top}px` : '';
			const gap = shown ? overGap(block) : null;
			// Over a gap, the handle spans it from its left edge to the block (`span`),
			// and its box takes the pointer at its block's row (`row`): relative to
			// the host's top, which is centered on the first line.
			const span = gap ? `${Math.max(0, rect.left - gap.left)}px` : '';
			const row = gap
				? `${rect.top - (center - host.offsetHeight / 2)}px ${ownRowBottom(node, rect) - rect.top}px`
				: '';
			const next = shown ? `${left} ${top} ${row} ${span}` : 'none';
			if (next === at) return;
			return () => {
				at = next;
				host.style.visibility = '';
				host.style.display = shown ? '' : 'none';
				if (gap) overGaps.add(id);
				else overGaps.delete(id);
				const [rowTop = '', rowHeight = ''] = row.split(' ');
				host.style.setProperty('--edytor-handle-row-top', rowTop);
				host.style.setProperty('--edytor-handle-row-height', rowHeight);
				host.style.setProperty('--edytor-handle-gap-width', span);
				if (shown) Object.assign(host.style, { left, top });
			};
		});
		return {
			destroy: () => {
				off();
				overGaps.delete(id);
			}
		};
	};
</script>

{#each ids as id (id)}
	<span
		contenteditable="false"
		data-edytor-block-handle-host
		data-block-id={id}
		data-visible={hovered.has(id) ? 'true' : undefined}
		data-over-gap={overGaps.has(id) ? 'true' : undefined}
		data-dragging={controller.dragging && controller.dragging !== id ? 'true' : undefined}
		data-selecting={edytor.selection.dragging ? 'true' : undefined}
		use:place={id}
		onfocusin={() => (focused = id)}
		onfocusout={() => focused === id && (focused = null)}
		><BlockHandle block={blocks.get(id)!} {controller} {handle} /></span
	>
{/each}

<style>
	[data-edytor-block-handle-host] {
		position: absolute;
		z-index: 5;
		display: flex;
		align-items: center;
		/* Flush with its block, the 4px before it the host's own: a pointer going
		 * from the text to the grip never crosses anything else. */
		padding-inline-end: 4px;
		transform: translate(-100%, -50%);
		opacity: 0;
		transition: opacity 150ms ease;
	}

	/* While a block drags, the pointer reaches the blocks under the other
	 * handles: a nested block's handle sits over its ancestors' columns, the
	 * drop levels. (The source keeps its own: Chrome cancels a drag whose
	 * source stops taking the pointer as it starts.) */
	[data-edytor-block-handle-host][data-dragging='true'] {
		pointer-events: none;
	}

	/* While a text selection runs (a press in the host, until its release), the
	 * handles take no pointer: the native selection is computed against the
	 * host, never against a handle beside it (Notion stops it at the column). */
	[data-edytor-block-handle-host][data-selecting='true'],
	[data-edytor-block-handle-host][data-selecting='true']::before {
		pointer-events: none;
	}

	/* Over a gap between two columns (one hit rule, the handles'): the handle
	 * spans the gap, its `+` (compact) at the gap's left edge and its grip
	 * flush with its block, and its box takes the pointer at its block's whole
	 * row, shown or not — a pointer there hovers the block, so its grip is
	 * reached from any side. The column resize band sits above, at the gap's
	 * middle, between the two (`columns/gaps.ts`): at the default 46px gap
	 * (18 + 10 + 18) neither button is under it, and where its guide shows a
	 * press resizes. */
	[data-edytor-block-handle-host][data-over-gap='true'] {
		box-sizing: border-box;
		width: var(--edytor-handle-gap-width, auto);
		justify-content: space-between;
		padding-inline-end: 0;
	}

	[data-edytor-block-handle-host][data-over-gap='true'] :global(.edytor-block-add) {
		width: 18px;
	}

	[data-edytor-block-handle-host][data-over-gap='true']::before {
		content: '';
		position: absolute;
		z-index: -1;
		left: 0;
		right: 0;
		top: var(--edytor-handle-row-top, 0px);
		height: var(--edytor-handle-row-height, 100%);
	}

	[data-edytor-block-handle-host][data-visible='true'],
	[data-edytor-block-handle-host]:hover,
	[data-edytor-block-handle-host]:focus-within {
		opacity: 1;
	}

	@media (hover: none) {
		[data-edytor-block-handle-host] {
			opacity: 1;
			padding-inline-end: 0;
		}
	}
</style>
