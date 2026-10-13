<script lang="ts">
	import { Button } from '$registry/ui/button/index.js';
	import { Textarea } from '$registry/ui/textarea/index.js';
	import { words } from './words.svelte.js';
	import { tick } from 'svelte';
	import type { CommentCardPayload } from 'edytor';

	/**
	 * Notion's comment card, drawn for `createCommentsPlugin({ card })`: the
	 * comment being written (its quote, a field, Cancel and Comment), or a
	 * thread (its quote, Resolve or Re-open, its comments, a reply field
	 * while it is the active one).
	 */
	let { card }: { card: CommentCardPayload } = $props();
	const { thread, comments } = $derived(card);
	const labels = $derived(words.comments);
	/** A user's name: theirs, else the current user is You and another their id. */
	const nameOf = (id: string) =>
		id === comments.user.id && !comments.user.name ? labels.you : comments.userOf(id).name!;

	/** The composer's text: it empties once posted. */
	let body = $state('');

	/** Post the composer's text: the draft's as a new thread, else a reply. */
	const post = async () => {
		const posted = await (thread ? comments.reply(thread.id, body) : comments.submit(body));
		if (posted) body = '';
		return posted;
	};

	/** The field's keys: Enter posts (Shift+Enter is a new line), Escape gives up a draft. */
	const keydown = (event: KeyboardEvent) => {
		if (event.isComposing) return;
		if (event.key === 'Escape' && !thread) {
			event.preventDefault();
			comments.cancel();
		} else if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			// The field empties too once posted, even when its card went (a posted draft).
			const field = event.currentTarget as HTMLTextAreaElement;
			void post().then((posted) => posted && (field.value = ''));
		}
	};
</script>

{#snippet composer()}
	{@const label = thread ? labels.reply : labels.placeholder}
	<div data-edytor-comment-composer>
		<!-- The draft's field takes the focus as it mounts. -->
		<Textarea
			data-edytor-comment-field={thread ? undefined : ''}
			data-edytor-comment-reply={thread ? '' : undefined}
			rows={1}
			placeholder={label}
			aria-label={label}
			bind:value={body}
			onkeydown={keydown}
			{@attach !thread && ((node) => void tick().then(() => node.focus({ preventScroll: true })))}
		></Textarea>
		{#if !thread || body.trim()}
			<div data-edytor-comment-actions>
				{#if !thread}
					<Button variant="ghost" data-edytor-comment-cancel onclick={comments.cancel}
						>{labels.cancel}</Button
					>
				{/if}
				<Button variant="ghost" data-edytor-comment-post disabled={!body.trim()} onclick={post}
					>{labels.post}</Button
				>
			</div>
		{/if}
	</div>
{/snippet}

<div data-comment-card>
	{#if !thread}
		{#if comments.draft?.quote}
			<blockquote data-edytor-comment-quote>{comments.draft.quote}</blockquote>
		{/if}
		{@render composer()}
		{#if comments.error}<p data-edytor-comment-error role="alert">{labels.failed}</p>{/if}
	{:else}
		<div data-edytor-comment-head>
			{#if thread.quote}
				<blockquote data-edytor-comment-quote>{thread.quote}</blockquote>
			{/if}
			{#if comments.canComment}
				{#if thread.resolved}
					<Button
						variant="ghost"
						data-edytor-comment-reopen
						title={labels.reopen}
						onclick={() => comments.reopen(thread.id)}>{labels.reopen}</Button
					>
				{:else}
					<Button
						variant="ghost"
						data-edytor-comment-resolve
						title={labels.resolve}
						aria-label={labels.resolve}
						onclick={() => comments.resolve(thread.id)}>✓</Button
					>
				{/if}
			{/if}
		</div>
		{#if thread.resolved}
			<p data-edytor-comment-resolved>
				{labels.resolvedBy(nameOf(thread.resolved.by))}
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
							<span data-edytor-comment-avatar style:background={author.color} aria-hidden="true"
								>{nameOf(comment.author).slice(0, 1).toUpperCase()}</span
							>
						{/if}
						<span data-edytor-comment-author>{nameOf(comment.author)}</span>
						<time data-edytor-comment-time datetime={new Date(comment.createdAt).toISOString()}
							>{labels.when(comment.createdAt)}</time
						>
						{#if comments.mayDelete(thread, comment)}
							<Button
								variant="ghost"
								data-edytor-comment-delete
								title={labels.delete}
								aria-label={labels.delete}
								onclick={() =>
									comments.remove(
										thread.id,
										comment.id === thread.comments[0]?.id ? undefined : comment.id
									)}>×</Button
							>
						{/if}
					</div>
					<p data-edytor-comment-body>{comment.body}</p>
				</li>
			{/each}
		</ol>
		{#if card.active && comments.canComment && !thread.resolved}
			{@render composer()}
		{/if}
	{/if}
</div>

<style>
	[data-comment-card] {
		padding: 10px 12px;
		border-radius: 8px;
		background: var(--edytor-comments-background, var(--popover));
		box-shadow:
			var(--accent) 0 0 0 1px,
			var(--border) 0 3px 6px;
		font:
			14px/1.45 ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Helvetica,
			sans-serif;
		color: var(--edytor-comments-color, var(--popover-foreground));
	}
	:global([data-edytor-comment-card][data-active]) [data-comment-card] {
		box-shadow:
			var(--border) 0 0 0 1px,
			var(--border) 0 6px 14px;
	}
	:global([data-edytor-comment-card][data-resolved]) [data-comment-card] {
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
		border-left: 2px solid var(--edytor-color-yellow);
		color: var(--muted-foreground);
		font-size: 13px;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	[data-edytor-comment-head] :global(button),
	:global([data-edytor-comment-delete]) {
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--muted-foreground);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		padding: 0 6px;
	}
	[data-edytor-comment-head] :global(button:hover),
	:global([data-edytor-comment-delete]:hover) {
		background: var(--accent);
	}
	[data-edytor-comment-resolved] {
		margin: 0 0 6px;
		font-size: 12px;
		color: var(--muted-foreground);
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
		color: var(--primary-foreground);
		font-size: 11px;
		font-weight: 600;
		object-fit: cover;
	}
	[data-edytor-comment-author] {
		font-weight: 600;
		font-size: 13px;
	}
	[data-edytor-comment-time] {
		color: var(--muted-foreground);
		font-size: 12px;
	}
	:global([data-edytor-comment-delete]) {
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
	[data-edytor-comment-composer] :global(textarea) {
		box-sizing: border-box;
		width: 100%;
		min-height: 32px;
		resize: vertical;
		border: 1px solid var(--border);
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
	[data-edytor-comment-actions] :global(button) {
		border: 0;
		border-radius: 6px;
		padding: 4px 10px;
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		background: var(--accent);
		color: inherit;
	}
	:global([data-edytor-comment-post]) {
		background: var(--primary) !important;
		color: var(--primary-foreground) !important;
	}
	:global([data-edytor-comment-post]:disabled) {
		opacity: 0.4;
		cursor: default;
	}
	[data-edytor-comment-error] {
		margin: 6px 0 0;
		font-size: 12px;
		color: var(--destructive);
	}
</style>
