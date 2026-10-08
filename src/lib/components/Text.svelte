<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { RenderDelta } from '$lib/surface/cells.js';
	import { Text } from '../text/text.svelte.js';
	import Mark from './Mark.svelte';

	/**
	 * One segment of a cell: its render deltas, the empty filler, the
	 * trailing-newline marker and the placeholder attribute (shown
	 * by the `::before` rule below). `text` is the handle the element maps to
	 * for the operations and the selection; a segment re-keyed or
	 * shifted rebinds it without remounting the element.
	 */
	let {
		text,
		deltas,
		empty,
		newline,
		placeholder = null,
		rest = false
	}: {
		text: Text | undefined;
		deltas: readonly RenderDelta[];
		empty: boolean;
		newline: boolean;
		placeholder?: string | null;
		/** The rest a live composition merged into its host, shown after it (`pin.rest`). */
		rest?: boolean;
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
	 * block lands in the node the browser (and the IME) already holds.
	 */
	const FILLER: readonly RenderDelta[] = [{ text: '\u200B', marks: [] }];

	/** A plain click (no drag, no Shift, a single press) places the caret at the pointer. */
	const restoreTextSelectionFromClick = (node: HTMLElement) => {
		let pointerStart: { clientX: number; clientY: number } | null = null;
		const pointerdown = ({ button, shiftKey, clientX, clientY }: PointerEvent) => {
			pointerStart = button !== 0 || shiftKey ? null : { clientX, clientY };
		};
		const click = (event: MouseEvent) => {
			const start = pointerStart;
			pointerStart = null;
			if (event.button !== 0 || event.detail !== 1 || event.shiftKey || !start) return;
			const movement = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
			if (movement < 4 && text)
				edytor.selection.pointer.placeAt(text, event.clientX, event.clientY);
		};
		node.addEventListener('pointerdown', pointerdown);
		node.addEventListener('click', click);
		return {
			destroy: () => {
				node.removeEventListener('pointerdown', pointerdown);
				node.removeEventListener('click', click);
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
	data-edytor-composition-rest={rest || undefined}
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
	/* The placeholder: the library's rule; out of flow, so the caret stays at the start. */
	:global([data-edytor-text][data-placeholder]::before) {
		content: attr(data-placeholder);
		position: absolute;
		white-space: nowrap;
		pointer-events: none;
		user-select: none;
		opacity: 0.45;
	}
</style>
