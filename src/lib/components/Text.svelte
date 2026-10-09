<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { RenderDelta } from '$lib/surface/cells.js';
	import { Text } from '../text/text.svelte.js';
	import Mark, { customAt } from './Mark.svelte';
	import CustomMark from './CustomMark.svelte';

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
	 * text node, so the first character typed or composed into an empty
	 * block lands in the node the browser (and the IME) already holds.
	 */
	const FILLER: readonly RenderDelta[] = [{ text: '\u200B', marks: [] }];

	/** A delta's marks this view renders (an unknown mark renders its text only). */
	const rendered = (delta: RenderDelta): RenderDelta => {
		const known = delta.marks.filter(([name]) => {
			const definition = edytor.marks.get(name);
			return Boolean(definition?.snippet || definition?.tag);
		});
		return known.length === delta.marks.length ? delta : { text: delta.text, marks: known };
	};
	const shown = $derived(empty ? FILLER : deltas);
	/**
	 * The first delta's text when it is unmarked: the element's own first
	 * text node, never re-created while the text starts unmarked (a plain
	 * text is this node alone: no anchor per delta, `render.markers`).
	 */
	const head = $derived(shown[0] && !shown[0].marks.length ? shown[0].text : '');
	/**
	 * The deltas after it, keyed by position and marks, then the trailing
	 * newline's marker (`delta: null`): one keyed list.
	 */
	const tail = $derived.by(() => {
		const from = shown[0] && !shown[0].marks.length ? 1 : 0;
		const items: { key: string; delta: RenderDelta | null }[] = [];
		for (let index = from; index < shown.length; index++)
			items.push({ key: getDeltaKey(shown[index]!, index), delta: rendered(shown[index]!) });
		if (newline) items.push({ key: 'newline', delta: null });
		return items;
	});

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
	>{head}<!--
	-->{#each tail as item (item.key)}<!--
-->{#if item.delta === null}<!--
--><span
				class="newline"
				data-edytor-trailing-newline>&#8203;</span
			><!--
-->{:else if customAt(edytor, item.delta, 0)}<!--
--><CustomMark
				delta={item.delta}
				index={0}
				{text}
			/><!--
-->{:else if item.delta.marks.length}<!--
--><Mark
				delta={item.delta}
				index={0}
				{text}
			/><!--
-->{:else}<!--
-->{item.delta.text}<!--
-->{/if}<!--
-->{/each}<!--
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
