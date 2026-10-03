<script lang="ts">
	import { onMount } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import { Text } from '$lib/text/text.svelte.js';
	import type { Snippet } from 'svelte';
	import BlockHandle from './BlockHandle.svelte';
	import type { BlockHandleSnippetPayload } from './blockHandlesPlugin.js';
	import type { BlockHandleController } from './BlockHandleController.svelte.js';

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

	/**
	 * A block directly in a layout's column: its handle sits in the gap
	 * between two columns, which the resize strip takes wherever no shown
	 * handle does — its handle takes the pointer only while shown.
	 */
	const inColumn = (id: string) => {
		void structure;
		const parent = blocks.get(id)?.parent;
		return !!parent && !parent.isRoot && edytor.facade.isLayoutItem(parent.id);
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
			const left = `${rect.left - origin.left}px`;
			const top = shown ? `${firstRowCenter(node, block) - origin.top}px` : '';
			const next = shown ? `${left} ${top}` : 'none';
			if (next === at) return;
			return () => {
				at = next;
				host.style.visibility = '';
				host.style.display = shown ? '' : 'none';
				if (shown) Object.assign(host.style, { left, top });
			};
		});
		return { destroy: off };
	};
</script>

{#each ids as id (id)}
	<span
		contenteditable="false"
		data-edytor-block-handle-host
		data-block-id={id}
		data-visible={hovered.has(id) ? 'true' : undefined}
		data-in-column={inColumn(id) && controller.dragging !== id ? 'true' : undefined}
		data-dragging={controller.dragging && controller.dragging !== id ? 'true' : undefined}
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
		transform: translate(calc(-100% - 4px), -50%);
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

	/* In a column's gap the resize strip takes the pointer where no handle shows
	 * (a drag's source keeps it: an engine cancels a drag whose source stops
	 * taking the pointer). */
	@media (hover: hover) {
		[data-edytor-block-handle-host][data-in-column='true']:not([data-visible='true']):not(
				:hover
			):not(:focus-within):not(:active) {
			pointer-events: none;
		}
	}

	[data-edytor-block-handle-host][data-visible='true'],
	[data-edytor-block-handle-host]:hover,
	[data-edytor-block-handle-host]:focus-within {
		opacity: 1;
	}

	@media (hover: none) {
		[data-edytor-block-handle-host] {
			opacity: 1;
			transform: translate(-100%, -50%);
		}
	}
</style>
