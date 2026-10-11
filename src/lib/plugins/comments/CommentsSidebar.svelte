<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { rangeRects } from '$lib/collaboration/remoteSelection.js';
	import { hidden } from '$lib/selection/visibility.js';
	import type { CommentRun } from '$lib/crdt/protocols/comments.js';
	import type { CommentsController, PlacedThread } from './CommentsController.svelte.js';
	import type { CommentCardPayload } from './commentsPlugin.js';

	/**
	 * The comments' place in the overlay: the threads' highlight, the text of
	 * the comment being written, and the sidebar beside the text (Notion's
	 * margin; under its text on a narrow screen, the active one only) whose
	 * cards the plugin's `card` snippet draws (the comment being written:
	 * `thread` is `null`), under its `header` snippet.
	 */
	let {
		edytor,
		comments,
		card,
		header
	}: {
		edytor: Edytor;
		comments: CommentsController;
		/** A card's markup (the plugin's `card` option). */
		card: Snippet<[CommentCardPayload]>;
		/** The margin's top (the plugin's `header` option). */
		header?: Snippet<[CommentsController]>;
	} = $props();

	const labels = $derived(comments.labels);

	/** The sidebar's width, and the gap between the text and the sidebar, and between cards. */
	const WIDTH = 288;
	const GAP = 32;
	const SPACING = 10;
	/** The key of the card being written (no thread id holds a colon). */
	const DRAFT = ':draft';

	type Rect = { left: number; top: number; width: number; height: number };
	type Layout = {
		/** `margin`: beside the text, every shown thread; `popover`: the active one under its text. */
		mode: 'margin' | 'popover';
		left: number;
		/** Each placed card's position, by thread id (the draft's: `DRAFT`). */
		cards: Record<string, { top: number; left: number }>;
		/** The draft's text, highlighted until it is posted. */
		draft: Rect[];
		/** Where the header sits. */
		header: number;
	};

	let layout: Layout = $state.raw({ mode: 'margin', left: 0, cards: {}, draft: [], header: 0 });
	let container: HTMLElement | undefined = $state();
	let top: HTMLElement | undefined = $state();

	/** A run's text boxes, relative to the overlay. */
	const rectsOf = (run: CommentRun, origin: DOMRect): Rect[] => {
		const block = edytor.idToBlock.get(run.block);
		const [start, end] = [
			block?.textAtOffset(run.offset),
			block?.textAtOffset(run.offset + run.length)
		];
		return start && end ? rangeRects(edytor, start, end, origin) : [];
	};

	/** The runs' first line box, relative to the overlay: the text's own, else its block's, else the host's top. */
	const anchorOf = (runs: CommentRun[], origin: DOMRect, top: number): Rect => {
		for (const run of runs) {
			const block = edytor.idToBlock.get(run.block);
			if (!block) continue;
			const rect = hidden(block) ? undefined : rectsOf(run, origin)[0];
			if (rect) return rect;
			const node = block.node?.closest('details:not([open])') ?? block.node;
			if (!node) continue;
			const box = node.getBoundingClientRect();
			return {
				left: box.left - origin.left,
				top: box.top - origin.top,
				width: box.width,
				height: 20
			};
		}
		return { left: 0, top, width: 0, height: 20 };
	};

	/**
	 * One read pass of the overlay: where each card goes. Beside the
	 * text when the viewport has room (Notion's margin), the active card at
	 * its text's height and the others stacked above and below it without
	 * overlapping; otherwise only the active card, under its text.
	 */
	const measure = (origin: DOMRect) => {
		const host = edytor.node;
		const view = host?.ownerDocument.defaultView;
		if (!host || !view || !container) return;
		const hostRect = host.getBoundingClientRect();
		const margin = hostRect.right + GAP + WIDTH <= view.innerWidth - 8;
		const draftRuns = comments.draft ? comments.draftRuns() : [];
		const heights = new Map<string, number>();
		for (const node of container.querySelectorAll<HTMLElement>('[data-edytor-comment-card]'))
			heights.set(node.dataset.edytorCommentCard!, node.getBoundingClientRect().height);
		const heightOf = (id: string) => heights.get(id) || 96;
		const hostTop = hostRect.top - origin.top;
		const active = comments.draft ? DRAFT : comments.active;
		const items = [
			...(comments.draft ? [{ id: DRAFT, runs: draftRuns }] : []),
			...comments.shown.filter((thread) => margin || thread.id === active)
		]
			.map(({ id, runs }) => ({ id, anchor: anchorOf(runs, origin, hostTop) }))
			.sort((a, b) => a.anchor.top - b.anchor.top);
		const cards: Layout['cards'] = {};
		if (margin) {
			const head = top?.getBoundingClientRect().height ?? 0;
			const floor = hostTop + (head ? head + SPACING : 0);
			const at = items.findIndex((item) => item.id === active);
			const place = (from: number, y: number) => {
				for (let i = from; i < items.length; i++) {
					const top = Math.max(items[i]!.anchor.top, y);
					cards[items[i]!.id] = { top, left: 0 };
					y = top + heightOf(items[i]!.id) + SPACING;
				}
			};
			if (at < 0) place(0, floor);
			else {
				const pinned = Math.max(items[at]!.anchor.top, floor);
				cards[items[at]!.id] = { top: pinned, left: -12 };
				place(at + 1, pinned + heightOf(items[at]!.id) + SPACING);
				let limit = pinned - SPACING;
				for (let i = at - 1; i >= 0; i--) {
					const top = Math.min(items[i]!.anchor.top, limit - heightOf(items[i]!.id));
					cards[items[i]!.id] = { top, left: 0 };
					limit = top - SPACING;
				}
			}
		} else {
			const width = Math.min(WIDTH, view.innerWidth - 16);
			for (const { id, anchor } of items) {
				const x = Math.min(
					Math.max(anchor.left, 8 - origin.left),
					view.innerWidth - 8 - width - origin.left
				);
				cards[id] = { top: anchor.top + anchor.height + 6, left: x };
			}
		}
		const next: Layout = {
			mode: margin ? 'margin' : 'popover',
			left: margin ? hostRect.right - origin.left + GAP : 0,
			cards,
			draft: draftRuns.flatMap((run) => rectsOf(run, origin)),
			header: hostTop
		};
		if (JSON.stringify(next) === JSON.stringify(layout)) return;
		return () => (layout = next);
	};

	onMount(() => edytor.overlay.add(measure));
	// Anything that moves a card: measure again (the cards' own heights settle in the next frame).
	$effect(() => {
		void comments.shown;
		void comments.active;
		void comments.draft;
		void comments.anchors;
		void comments.showResolved;
		edytor.overlay.invalidate();
	});

	/**
	 * The cards: the draft's first (`null`), then the threads; on a narrow
	 * screen only the active thread. A card the overlay has not placed yet
	 * renders hidden until its frame.
	 */
	const cards: (PlacedThread | null)[] = $derived([
		...(comments.draft ? [null] : []),
		...(layout.mode === 'margin'
			? comments.shown
			: comments.shown.filter((thread) => thread.id === comments.active))
	]);
</script>

<!-- The highlight of the threads' text: one stylesheet, never an attribute of the editor's own elements. -->
<svelte:head>
	<svelte:element this={'style'} data-edytor-comments-style>{comments.css}</svelte:element>
</svelte:head>

<div data-edytor-comment-ranges aria-hidden="true">
	{#each layout.draft as rect, index (index)}
		<span
			data-edytor-comment-draft
			style:left={`${rect.left}px`}
			style:top={`${rect.top}px`}
			style:width={`${rect.width}px`}
			style:height={`${rect.height}px`}
		></span>
	{/each}
</div>

<div
	bind:this={container}
	data-edytor-comments
	data-mode={layout.mode}
	role="complementary"
	aria-label={labels.sidebar}
	style:left={`${layout.left}px`}
	style:--edytor-comments-width={`${WIDTH}px`}
>
	{#if header && layout.mode === 'margin'}
		<div bind:this={top} data-edytor-comments-header style:top={`${layout.header}px`}>
			{@render header(comments)}
		</div>
	{/if}

	{#each cards as thread (thread?.id ?? DRAFT)}
		{@const id = thread?.id ?? DRAFT}
		{@const active = thread?.id === comments.active}
		{@const at = layout.cards[id]}
		<!-- A press on a thread's card makes it the active one; its buttons and fields keep their keys. -->
		<div
			data-edytor-comment-card={id}
			data-edytor-comment-new={thread ? undefined : ''}
			data-active={thread ? active || undefined : ''}
			data-resolved={thread?.resolved ? '' : undefined}
			data-unplaced={at ? undefined : ''}
			role={thread ? 'article' : undefined}
			aria-label={thread ? labels.comment : undefined}
			style:top={`${at?.top ?? 0}px`}
			style:left={`${at?.left ?? 0}px`}
			onclick={(event) => {
				if (thread && !(event.target as Element).closest('button, textarea'))
					comments.focus(thread.id);
			}}
		>
			{@render card({ thread, comments, active })}
		</div>
	{/each}
</div>

<style>
	[data-edytor-comment-ranges] {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
		z-index: 17;
	}
	[data-edytor-comment-draft] {
		position: absolute;
		background: var(--edytor-comment-active, rgb(255 212 0 / 0.42));
		mix-blend-mode: multiply;
	}
	[data-edytor-comments] {
		position: absolute;
		top: 0;
		width: 0;
		z-index: 30;
	}
	[data-edytor-comments-header],
	[data-edytor-comment-card] {
		position: absolute;
		box-sizing: border-box;
		width: var(--edytor-comments-width);
	}
	[data-edytor-comment-card] {
		transition:
			top 120ms ease,
			left 120ms ease;
	}
	/* Not placed yet (its first frame): unseen, yet focusable (a new thread's field). */
	[data-edytor-comment-card][data-unplaced] {
		opacity: 0;
		pointer-events: none;
	}
</style>
