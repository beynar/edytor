<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { RenderDelta } from '$lib/surface/cells.js';
	import { Text } from '../text/text.svelte.js';
	import Mark from './Mark.svelte';

	/**
	 * One segment of a cell (R2): its render deltas, the empty filler, the
	 * trailing-newline marker and the placeholder attribute (§2.4, D-8: shown
	 * by the `::before` rule below). `text` is the handle the element maps to
	 * for the operations and the selection (R3/R4); a segment re-keyed or
	 * shifted rebinds it without remounting the element.
	 */
	let {
		text,
		deltas,
		empty,
		newline,
		placeholder = null
	}: {
		text: Text | undefined;
		deltas: readonly RenderDelta[];
		empty: boolean;
		newline: boolean;
		placeholder?: string | null;
	} = $props();

	const edytor = getContext<Edytor>('edytor');

	const attachText = (node: HTMLElement, initialText: Text | undefined) => {
		let attachedText = initialText;
		// A suggestion's ghost text has no handle and attaches nothing.
		let attachment = attachedText?.attach(node);

		return {
			update(nextText: Text | undefined) {
				if (!nextText || nextText === attachedText) return;
				attachment?.destroy();
				attachedText = nextText;
				attachment = attachedText.attach(node);
			},
			destroy() {
				attachment?.destroy();
			}
		};
	};

	const getDeltaKey = (delta: RenderDelta, index: number) =>
		`${index}:${JSON.stringify(delta.marks)}`;
	/**
	 * An empty text renders the filler as its first unmarked delta: the same
	 * keyed item, so the first character typed or composed into an empty
	 * block lands in the node the browser (and the IME) already holds (BI-15).
	 */
	const FILLER: readonly RenderDelta[] = [{ text: '\u200B', marks: [] }];

	const restoreTextSelectionFromClick = (node: HTMLElement) => {
		let pointerStart: { clientX: number; clientY: number } | null = null;

		const handlePointerDown = (event: PointerEvent) => {
			if (event.button !== 0 || event.shiftKey) {
				pointerStart = null;
				return;
			}

			pointerStart = {
				clientX: event.clientX,
				clientY: event.clientY
			};
		};

		const handleClick = (event: MouseEvent) => {
			if (event.button !== 0 || event.detail !== 1 || event.shiftKey || !pointerStart) {
				pointerStart = null;
				return;
			}

			const movement = Math.hypot(
				event.clientX - pointerStart.clientX,
				event.clientY - pointerStart.clientY
			);
			pointerStart = null;
			if (movement >= 4) {
				return;
			}

			if (text) edytor.selection.setTextSelectionFromPointer(text, event.clientX, event.clientY);
		};

		node.addEventListener('pointerdown', handlePointerDown);
		node.addEventListener('click', handleClick);

		return {
			destroy: () => {
				node.removeEventListener('pointerdown', handlePointerDown);
				node.removeEventListener('click', handleClick);
			}
		};
	};
</script>

<!-- The comment blocks are needed to prevent unwanted text nodes with whitespace. -->
<!-- thanks for the tip: https://github.com/michael/svedit/blob/main/src/lib/Text.svelte -->

<span
	use:attachText={text}
	use:restoreTextSelectionFromClick
	data-edytor-text-empty={empty ? 'true' : 'false'}
	data-placeholder={placeholder ?? undefined}
	style:white-space="break-spaces"
	><!--
	-->{#each empty ? FILLER : deltas as delta, index (getDeltaKey(delta, index))}<!--
-->{#if delta.marks.length}<!--
--><Mark
				{delta}
				index={0}
				{text}
			/><!--
-->{:else}<!--
-->{delta.text}<!--
-->{/if}<!--
-->{/each}<!--
-->{#if newline}<!--
--><span
			class="newline"
			data-edytor-trailing-newline>&#8203;</span
		><!--
-->{/if}<!--
--></span
>

<!--
-->

<style>
	/* The placeholder (D-8): the library's rule; out of flow, so the caret stays at the start. */
	:global([data-edytor-text][data-placeholder]::before) {
		content: attr(data-placeholder);
		position: absolute;
		white-space: nowrap;
		pointer-events: none;
		user-select: none;
		opacity: 0.45;
	}
</style>
