<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { scheduleRemoveStalePlaceholders } from '$lib/text/removeStalePlaceholders.js';
	import type { RenderDelta } from '$lib/surface/cells.js';
	import { Text } from '../text/text.svelte.js';
	import Mark from './Mark.svelte';

	/**
	 * One segment of a cell (R2): its render deltas, the empty filler and the
	 * trailing-newline marker. `text` is the wrapper the element maps to for
	 * the operations and the selection (R3/R4); a segment re-keyed or shifted
	 * rebinds it without remounting the element.
	 */
	let {
		text,
		deltas,
		empty,
		newline,
		placeholder = false
	}: {
		text: Text | undefined;
		deltas: readonly RenderDelta[];
		empty: boolean;
		newline: boolean;
		placeholder?: boolean;
	} = $props();

	const edytor = getContext<Edytor>('edytor');
	let hasDomText = $state(false);

	const attachText = (node: HTMLElement, initialText: Text | undefined) => {
		let attachedText = initialText;
		// `ReadonlyText.attach` returns undefined — only the live Text
		// adapter hands back a `{destroy}` handle.
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

	const focusPlaceholder = (event?: Event) => {
		event?.preventDefault();
		event?.stopPropagation();
		edytor.node?.focus();
		void edytor.selection.setAtTextOffset(text, 0);
	};

	const focusPlaceholderWithKeyboard = (event: KeyboardEvent) => {
		if (event.key === 'Enter' || event.key === ' ') {
			focusPlaceholder(event);
		}
	};

	const blockHasVisibleText = (node: HTMLElement) =>
		Array.from(node.parentElement?.children ?? []).some(
			(textNode) =>
				textNode.matches('[data-edytor-text="true"]') &&
				Boolean(textNode.textContent?.replaceAll('\u200B', '').length)
		);

	const removePlaceholderWhenBlockHasText = (node: HTMLElement) => {
		let observer: MutationObserver | null = null;
		let duplicateCleanupScheduled = false;

		const removeNode = () => {
			observer?.disconnect();
			node.remove();
		};

		const removeDuplicateSiblings = () => {
			// Direct children only — nested block children can render their
			// own placeholders inside the same parent element (heading/
			// quote), and a descendant query would miscount them as
			// duplicates of the parent's own placeholder.
			const placeholders = Array.from(node.parentElement?.children ?? []).filter((child) =>
				child.matches('[data-edytor-text-placeholder]')
			);
			const currentPlaceholder = placeholders.at(-1);
			if (currentPlaceholder && node !== currentPlaceholder) {
				removeNode();
				return;
			}

			placeholders.slice(0, -1).forEach((placeholder) => {
				placeholder.remove();
			});
		};

		const scheduleDuplicateCleanup = () => {
			if (duplicateCleanupScheduled) {
				return;
			}

			duplicateCleanupScheduled = true;
			setTimeout(() => {
				duplicateCleanupScheduled = false;
				removeDuplicateSiblings();
			});
		};

		const removeIfStale = () => {
			if (!text || text.stringContent.length > 0 || blockHasVisibleText(node)) {
				removeNode();
			}
		};

		if (typeof MutationObserver !== 'undefined' && node.parentElement) {
			observer = new MutationObserver(() => {
				removeIfStale();
				scheduleDuplicateCleanup();
			});
			observer.observe(node.parentElement, {
				characterData: true,
				childList: true,
				subtree: true
			});
		}

		removeIfStale();
		queueMicrotask(removeIfStale);
		setTimeout(removeIfStale);
		queueMicrotask(removeDuplicateSiblings);
		// The deferred duplicate-cleanup chain (50/250/1000ms) is folded
		// into the editor-wide coalesced repair queue — one pending entry
		// for this placeholder's parent instead of three dedicated timers
		// per mounted placeholder, all cancelled with the view. The
		// observer above stays: it covers the NON-commit-driven staleness
		// the commit-scoped queue can't see (a placeholder mounted while
		// `shouldShowPlaceholder` still holds that gains sibling DOM text
		// through a browser/mutation path that produced no facade commit).
		edytor.placeholderRepair.addKeyed(node, () => node.parentElement);

		return {
			destroy: () => observer?.disconnect()
		};
	};

	const trackTextDomContent = (node: HTMLElement) => {
		const updateDomTextState = () => {
			hasDomText = Boolean(node.textContent?.replaceAll('​', '').length);
			if (text) scheduleRemoveStalePlaceholders(text);
		};

		let observer: MutationObserver | null = null;
		if (typeof MutationObserver !== 'undefined') {
			observer = new MutationObserver(updateDomTextState);
			observer.observe(node, {
				characterData: true,
				childList: true,
				subtree: true
			});
		}
		queueMicrotask(updateDomTextState);

		return {
			destroy: () => observer?.disconnect()
		};
	};

	// The cell's placeholder attribute (§2.4), still gated on the DOM read (L34, R5).
	const shouldShowPlaceholder = $derived(placeholder && !hasDomText);

	$effect(() => {
		void deltas;
		if (text && (!empty || shouldShowPlaceholder)) scheduleRemoveStalePlaceholders(text);
	});
</script>

<!-- The comment blocks are needed to prevent unwanted text nodes with whitespace. -->
<!-- thanks for the tip: https://github.com/michael/svedit/blob/main/src/lib/Text.svelte -->

<span
	use:attachText={text}
	use:trackTextDomContent
	use:restoreTextSelectionFromClick
	data-edytor-text-empty={empty ? 'true' : 'false'}
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
><!--
--->{#if shouldShowPlaceholder && text && edytor.placeholder}<!--
--><span
		use:removePlaceholderWhenBlockHasText
		data-edytor-text-placeholder
		role="button"
		contentEditable="false"
		style="user-select: none;"
		tabindex="-1"
		onmousedown={focusPlaceholder}
		onclick={focusPlaceholder}
		onkeydown={focusPlaceholderWithKeyboard}
	>
		{#if typeof edytor.placeholder === 'string'}
			{edytor.placeholder}
		{:else}
			{@render edytor.placeholder({ block: text.parent })}
		{/if}
	</span><!--
	-->{/if}

<!--
-->

<style>
	:global(
		[data-edytor-text='true'][data-edytor-text-empty='false'] ~ [data-edytor-text-placeholder]
	) {
		display: none !important;
	}

	:global([data-edytor-text-placeholder]:has(~ [data-edytor-text-placeholder])) {
		display: none !important;
	}
</style>
