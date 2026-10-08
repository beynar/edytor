<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import type { Action } from 'svelte/action';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { rangeRects } from '$lib/collaboration/remoteSelection.js';
	import { hidden } from '$lib/selection/visibility.js';
	import type { CommentRun } from '$lib/crdt/protocols/comments.js';
	import type { CommentsController, PlacedThread } from './CommentsController.svelte.js';

	let {
		edytor,
		comments,
		card
	}: {
		edytor: Edytor;
		comments: CommentsController;
		/** Replace a thread card's markup (the plugin's `card` option). */
		card?: Snippet<[{ thread: PlacedThread; comments: CommentsController; active: boolean }]>;
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
		/** Where the resolved toggle sits. */
		toggle: number;
	};

	let layout: Layout = $state.raw({ mode: 'margin', left: 0, cards: {}, draft: [], toggle: 0 });
	let container: HTMLElement | undefined = $state();

	/** The runs' first line box, relative to the overlay: the text's own, else its block's. */
	const anchorOf = (runs: CommentRun[], origin: DOMRect): Rect | null => {
		for (const run of runs) {
			const block = edytor.idToBlock.get(run.block);
			if (!block) continue;
			if (!hidden(block)) {
				const [start, end] = [
					block.textAtOffset(run.offset),
					block.textAtOffset(run.offset + run.length)
				];
				const rect = start && end ? rangeRects(edytor, start, end, origin)[0] : undefined;
				if (rect) return rect;
			}
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
		return null;
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
		const draft = draftRuns.flatMap((run) => {
			const block = edytor.idToBlock.get(run.block);
			const [start, end] = [
				block?.textAtOffset(run.offset),
				block?.textAtOffset(run.offset + run.length)
			];
			return start && end ? rangeRects(edytor, start, end, origin) : [];
		});
		const heights = new Map<string, number>();
		for (const node of container.querySelectorAll<HTMLElement>('[data-edytor-comment-card]'))
			heights.set(node.dataset.edytorCommentCard!, node.getBoundingClientRect().height);
		const heightOf = (id: string) => heights.get(id) || 96;
		const hostTop = hostRect.top - origin.top;
		const items: Array<{ id: string; anchor: Rect }> = [];
		if (comments.draft) {
			const anchor = anchorOf(draftRuns, origin);
			items.push({ id: DRAFT, anchor: anchor ?? { left: 0, top: hostTop, width: 0, height: 20 } });
		}
		const active = comments.draft ? DRAFT : comments.active;
		for (const thread of comments.shown) {
			if (!margin && thread.id !== active) continue;
			const anchor = anchorOf(thread.runs, origin);
			items.push({
				id: thread.id,
				anchor: anchor ?? { left: 0, top: hostTop, width: 0, height: 20 }
			});
		}
		items.sort((a, b) => a.anchor.top - b.anchor.top);
		const cards: Layout['cards'] = {};
		const left = margin ? hostRect.right - origin.left + GAP : 0;
		if (margin) {
			const floor = hostTop + (comments.resolved.length > 0 ? 36 : 0);
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
			left,
			cards,
			draft,
			toggle: hostTop
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
	 * What the sidebar shows: on a narrow screen only the active thread. A
	 * card the overlay has not placed yet renders hidden until its frame.
	 */
	const placed = $derived(
		layout.mode === 'margin'
			? comments.shown
			: comments.shown.filter((thread) => thread.id === comments.active)
	);

	/**
	 * A composer field: Enter posts (Shift+Enter is a new line), Escape
	 * gives up; it takes the focus when it mounts if `focus`.
	 */
	const composer: Action<
		HTMLTextAreaElement,
		{ submit: (body: string) => Promise<boolean> | boolean; cancel?: () => void; focus?: boolean }
	> = (node, initial) => {
		let params = initial;
		if (params.focus) void tick().then(() => node.focus({ preventScroll: true }));
		const keydown = async (event: KeyboardEvent) => {
			if (event.isComposing) return;
			if (event.key === 'Escape' && params.cancel) {
				event.preventDefault();
				params.cancel();
			} else if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				const body = node.value;
				if (await params.submit(body)) {
					node.value = '';
					node.dispatchEvent(new Event('input', { bubbles: true }));
				}
			}
		};
		node.addEventListener('keydown', keydown);
		return {
			update: (next) => (params = next),
			destroy: () => node.removeEventListener('keydown', keydown)
		};
	};

	let draftBody = $state('');
	const postDraft = async () => {
		if (await comments.submit(draftBody)) draftBody = '';
	};
	const replies: Record<string, string> = $state({});
	const postReply = async (thread: string) => {
		if (await comments.reply(thread, replies[thread] ?? '')) replies[thread] = '';
	};
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
	{#if layout.mode === 'margin' && comments.resolved.length > 0}
		<button
			type="button"
			data-edytor-comments-toggle
			style:top={`${layout.toggle}px`}
			aria-pressed={comments.showResolved}
			onclick={() => (comments.showResolved = !comments.showResolved)}
			>{comments.showResolved
				? labels.hideResolved
				: labels.showResolved(comments.resolved.length)}</button
		>
	{/if}

	{#if comments.draft}
		<div
			data-edytor-comment-card={DRAFT}
			data-edytor-comment-new
			data-active
			data-unplaced={layout.cards[DRAFT] ? undefined : ''}
			style:top={`${layout.cards[DRAFT]?.top ?? 0}px`}
			style:left={`${layout.cards[DRAFT]?.left ?? 0}px`}
		>
			{#if comments.draft.quote}
				<blockquote data-edytor-comment-quote>{comments.draft.quote}</blockquote>
			{/if}
			<div data-edytor-comment-composer>
				<textarea
					data-edytor-comment-field
					rows="1"
					placeholder={labels.placeholder}
					aria-label={labels.placeholder}
					bind:value={draftBody}
					use:composer={{
						submit: (body) => comments.submit(body),
						cancel: comments.cancel,
						focus: true
					}}
				></textarea>
				<div data-edytor-comment-actions>
					<button type="button" data-edytor-comment-cancel onclick={comments.cancel}
						>{labels.cancel}</button
					>
					<button
						type="button"
						data-edytor-comment-post
						disabled={!draftBody.trim()}
						onclick={postDraft}>{labels.post}</button
					>
				</div>
			</div>
			{#if comments.error}<p data-edytor-comment-error role="alert">{labels.failed}</p>{/if}
		</div>
	{/if}

	{#each placed as thread (thread.id)}
		{@const active = thread.id === comments.active}
		<!-- A press on a card makes its thread the active one; its buttons and fields keep their keys. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<div
			data-edytor-comment-card={thread.id}
			data-active={active || undefined}
			data-resolved={thread.resolved ? '' : undefined}
			data-unplaced={layout.cards[thread.id] ? undefined : ''}
			role="article"
			aria-label={labels.comment}
			style:top={`${layout.cards[thread.id]?.top ?? 0}px`}
			style:left={`${layout.cards[thread.id]?.left ?? 0}px`}
			onclick={(event) => {
				if (!(event.target as Element).closest('button, textarea')) comments.focus(thread.id);
			}}
		>
			{#if card}
				{@render card({ thread, comments, active })}
			{:else}
				<div data-edytor-comment-head>
					{#if thread.quote}
						<blockquote data-edytor-comment-quote>{thread.quote}</blockquote>
					{/if}
					{#if comments.canComment}
						{#if thread.resolved}
							<button
								type="button"
								data-edytor-comment-reopen
								title={labels.reopen}
								onclick={() => comments.reopen(thread.id)}>{labels.reopen}</button
							>
						{:else}
							<button
								type="button"
								data-edytor-comment-resolve
								title={labels.resolve}
								aria-label={labels.resolve}
								onclick={() => comments.resolve(thread.id)}>✓</button
							>
						{/if}
					{/if}
				</div>
				{#if thread.resolved}
					<p data-edytor-comment-resolved>
						{labels.resolvedBy(comments.userOf(thread.resolved.by).name!)}
					</p>
				{/if}
				<ol data-edytor-comment-list>
					{#each thread.comments as comment (comment.id)}
						{@const author = comments.userOf(comment.author)}
						<li data-edytor-comment={comment.id}>
							<div data-edytor-comment-meta>
								{#if author.avatar}
									<img data-edytor-comment-avatar src={author.avatar} alt="" />
								{:else}
									<span
										data-edytor-comment-avatar
										style:background={author.color}
										aria-hidden="true">{author.name!.slice(0, 1).toUpperCase()}</span
									>
								{/if}
								<span data-edytor-comment-author>{author.name}</span>
								<time data-edytor-comment-time datetime={new Date(comment.createdAt).toISOString()}
									>{labels.when(comment.createdAt)}</time
								>
								{#if comments.mayDelete(thread, comment)}
									<button
										type="button"
										data-edytor-comment-delete
										title={labels.delete}
										aria-label={labels.delete}
										onclick={() =>
											comments.remove(
												thread.id,
												comment.id === thread.comments[0]?.id ? undefined : comment.id
											)}>×</button
									>
								{/if}
							</div>
							<p data-edytor-comment-body>{comment.body}</p>
						</li>
					{/each}
				</ol>
				{#if active && comments.canComment && !thread.resolved}
					<div data-edytor-comment-composer>
						<textarea
							data-edytor-comment-reply
							rows="1"
							placeholder={labels.reply}
							aria-label={labels.reply}
							bind:value={replies[thread.id]}
							use:composer={{ submit: (body) => comments.reply(thread.id, body) }}
						></textarea>
						{#if replies[thread.id]?.trim()}
							<div data-edytor-comment-actions>
								<button type="button" data-edytor-comment-post onclick={() => postReply(thread.id)}
									>{labels.post}</button
								>
							</div>
						{/if}
					</div>
				{/if}
			{/if}
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
		font:
			14px/1.45 ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Helvetica,
			sans-serif;
		color: var(--edytor-comments-color, rgb(55 53 47));
	}
	[data-edytor-comments-toggle] {
		position: absolute;
		left: 0;
		border: 0;
		border-radius: 6px;
		padding: 2px 8px;
		background: transparent;
		color: rgb(120 119 116);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	[data-edytor-comments-toggle]:hover {
		background: rgb(55 53 47 / 0.08);
	}
	[data-edytor-comment-card] {
		position: absolute;
		box-sizing: border-box;
		width: var(--edytor-comments-width);
		padding: 10px 12px;
		border-radius: 8px;
		background: var(--edytor-comments-background, #fff);
		box-shadow:
			rgb(15 15 15 / 0.05) 0 0 0 1px,
			rgb(15 15 15 / 0.1) 0 3px 6px;
		transition:
			top 120ms ease,
			left 120ms ease;
	}
	/* Not placed yet (its first frame): unseen, yet focusable (a new thread's field). */
	[data-edytor-comment-card][data-unplaced] {
		opacity: 0;
		pointer-events: none;
	}
	[data-edytor-comment-card][data-active] {
		box-shadow:
			rgb(15 15 15 / 0.08) 0 0 0 1px,
			rgb(15 15 15 / 0.16) 0 6px 14px;
	}
	[data-edytor-comment-card][data-resolved] {
		opacity: 0.75;
	}
	[data-edytor-comment-head] {
		display: flex;
		align-items: flex-start;
		gap: 6px;
	}
	[data-edytor-comment-quote] {
		flex: 1;
		margin: 0 0 6px;
		padding-left: 8px;
		border-left: 2px solid rgb(255 212 0 / 0.8);
		color: rgb(120 119 116);
		font-size: 13px;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	[data-edytor-comment-head] button,
	[data-edytor-comment-delete] {
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: rgb(120 119 116);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		padding: 0 6px;
	}
	[data-edytor-comment-head] button:hover,
	[data-edytor-comment-delete]:hover {
		background: rgb(55 53 47 / 0.08);
	}
	[data-edytor-comment-resolved] {
		margin: 0 0 6px;
		font-size: 12px;
		color: rgb(120 119 116);
	}
	[data-edytor-comment-list] {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	[data-edytor-comment-meta] {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	[data-edytor-comment-avatar] {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: #fff;
		font-size: 11px;
		font-weight: 600;
		object-fit: cover;
	}
	[data-edytor-comment-author] {
		font-weight: 600;
		font-size: 13px;
	}
	[data-edytor-comment-time] {
		color: rgb(120 119 116);
		font-size: 12px;
	}
	[data-edytor-comment-delete] {
		margin-left: auto;
	}
	[data-edytor-comment-body] {
		margin: 2px 0 0 26px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	[data-edytor-comment-composer] {
		margin-top: 8px;
	}
	[data-edytor-comment-composer] textarea {
		box-sizing: border-box;
		width: 100%;
		min-height: 32px;
		resize: vertical;
		border: 1px solid rgb(55 53 47 / 0.16);
		border-radius: 6px;
		padding: 6px 8px;
		font: inherit;
		color: inherit;
		background: transparent;
		field-sizing: content;
	}
	[data-edytor-comment-actions] {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
		margin-top: 6px;
	}
	[data-edytor-comment-actions] button {
		border: 0;
		border-radius: 6px;
		padding: 4px 10px;
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		background: rgb(55 53 47 / 0.06);
		color: inherit;
	}
	[data-edytor-comment-post] {
		background: rgb(35 131 226) !important;
		color: #fff !important;
	}
	[data-edytor-comment-post]:disabled {
		opacity: 0.4;
		cursor: default;
	}
	[data-edytor-comment-error] {
		margin: 6px 0 0;
		font-size: 12px;
		color: rgb(212 76 71);
	}
</style>
