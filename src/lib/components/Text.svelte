<script lang="ts">
	import { scheduleRemoveStalePlaceholders } from '$lib/text/removeStalePlaceholders.js';
	import { Text } from '../text/text.svelte.js';
	import Mark from './Mark.svelte';
	let {
		text
	}: {
		text: Text;
	} = $props();

	let hasDomText = $state(false);

	const getDeltaKey = (delta: Text['children'][number], index: number) =>
		`${index}:${JSON.stringify(delta.marks)}`;

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

			text.edytor.selection.setTextSelectionFromPointer(text, event.clientX, event.clientY);
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
		text.edytor.node?.focus();
		void text.edytor.selection.setAtTextOffset(text, 0);
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
			const placeholders = Array.from(
				node.parentElement?.querySelectorAll('[data-edytor-text-placeholder]') ?? []
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
			if (text.stringContent.length > 0 || blockHasVisibleText(node)) {
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
		setTimeout(removeDuplicateSiblings, 50);
		setTimeout(removeDuplicateSiblings, 250);
		setTimeout(removeDuplicateSiblings, 1000);

		return {
			destroy: () => observer?.disconnect()
		};
	};

	const trackTextDomContent = (node: HTMLElement) => {
		const updateDomTextState = () => {
			hasDomText = Boolean(node.textContent?.replaceAll('\u200B', '').length);
			scheduleRemoveStalePlaceholders(text);
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

	const shouldShowPlaceholder = $derived(
		text.domVersion >= 0 &&
			text.parent.content.length === 1 &&
			text.isEmpty &&
			!hasDomText &&
			!text.edytor.isComposing
	);

	$effect(() => {
		if (!text.isEmpty || text.stringContent.length > 0) {
			scheduleRemoveStalePlaceholders(text);
		}
	});

	$effect(() => {
		if (shouldShowPlaceholder) {
			scheduleRemoveStalePlaceholders(text);
		}
	});
</script>

<!-- The comment blocks are needed to prevent unwanted text nodes with whitespace. -->
<!-- thanks for the tip: https://github.com/michael/svedit/blob/main/src/lib/Text.svelte -->

<span
	use:text.attach
	use:trackTextDomContent
	use:restoreTextSelectionFromClick
	data-edytor-text-empty={text.isEmpty ? 'true' : 'false'}
	style:white-space="break-spaces"
	><!--
-->{#if text.isEmpty}<!--
-->&#8203;<!--
-->{:else}<!--
	-->{#each text.children as delta, index (getDeltaKey(delta, index))}<!--
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
-->{/if}<!--
-->{#if text.endsWithNewline}<!--
--><span
			class="newline"
			data-edytor-trailing-newline>&#8203;</span
		><!--
-->{/if}<!--
--></span
><!--
--->{#if shouldShowPlaceholder && text.edytor.placeholder}<!--
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
		{#if typeof text.edytor.placeholder === 'string'}
			{text.edytor.placeholder}
		{:else}
			{@render text.edytor.placeholder({ block: text.parent })}
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
