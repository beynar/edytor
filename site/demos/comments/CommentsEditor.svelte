<script lang="ts">
	import {
		Edytor,
		createCommentsPlugin,
		createMemoryCommentsClient,
		type CommentCardPayload,
		type CommentsController,
		type JSONDoc,
		type Plugin
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	const people: Record<string, { name: string; color: string }> = {
		ada: { name: 'Ada Lovelace', color: '#9065b0' },
		bob: { name: 'Bob Martin', color: '#337ea9' }
	};

	// Threads kept in memory: Bob asks, Ada answers.
	const client = createMemoryCommentsClient({ user: 'ada' });
	void client
		.as('bob')
		.send({
			op: 'add',
			thread: 't1',
			body: 'Is this the right wording?',
			quote: 'sentence already has one',
			block: 'intro'
		})
		.then(() => client.send({ op: 'reply', thread: 't1', body: 'Yes, ship it.' }));

	// Comment threads drawn with the two snippets below.
	const comments = createCommentsPlugin({
		client,
		user: { id: 'ada', ...people.ada },
		users: (id) => people[id],
		card,
		header
	});

	// The composer's text.
	let body = $state('');

	// Post the composer's text: a new thread for the draft, else a reply.
	const post = async (payload: CommentCardPayload) => {
		const { thread, comments } = payload;
		if (await (thread ? comments.reply(thread.id, body) : comments.submit(body))) body = '';
	};

	const keydown = (event: KeyboardEvent, payload: CommentCardPayload) => {
		if (event.isComposing) return;
		if (event.key === 'Escape' && !payload.thread) {
			event.preventDefault();
			payload.comments.cancel();
		} else if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void post(payload);
		}
	};
</script>

<!-- A sticky note: the author's colour as a stripe, the quote in italics. -->
{#snippet card(payload: CommentCardPayload)}
	{@const { thread, comments } = payload}
	<div class="note" data-resolved={!!thread?.resolved}>
		{#if thread}
			{#if thread.quote}<p class="quote">“{thread.quote}”</p>{/if}
			{#each thread.comments as comment (comment.id)}
				{@const author = comments.userOf(comment.author)}
				<div class="comment" style:--who={author.color ?? '#999'}>
					<strong>{author.name ?? comment.author}</strong>
					<span>{comment.body}</span>
					{#if comments.mayDelete(thread, comment)}
						<button
							class="quiet"
							aria-label="Delete comment"
							onclick={() =>
								comments.remove(
									thread.id,
									comment.id === thread.comments[0]?.id ? undefined : comment.id
								)}>×</button
						>
					{/if}
				</div>
			{/each}
			{#if comments.canComment}
				<div class="row">
					{#if thread.resolved}
						<button class="pill" onclick={() => comments.reopen(thread.id)}>Re-open</button>
					{:else}
						<button class="pill" onclick={() => comments.resolve(thread.id)}>Resolve</button>
					{/if}
				</div>
			{/if}
		{:else if comments.draft?.quote}
			<p class="quote">“{comments.draft.quote}”</p>
		{/if}
		{#if comments.canComment && !thread?.resolved && (!thread || payload.active)}
			<textarea
				rows="1"
				placeholder={thread ? 'Reply…' : 'Write a comment…'}
				aria-label={thread ? 'Reply' : 'New comment'}
				bind:value={body}
				onkeydown={(event) => keydown(event, payload)}
				{@attach (node) => {
					if (!thread) node.focus({ preventScroll: true });
				}}
			></textarea>
			{#if !thread}
				<div class="row">
					<button class="pill" onclick={comments.cancel}>Cancel</button>
					<button class="pill go" disabled={!body.trim()} onclick={() => post(payload)}>Post</button>
				</div>
			{/if}
		{/if}
	</div>
{/snippet}

<!-- The top of the margin: a count of the open threads and the resolved toggle. -->
{#snippet header(comments: CommentsController)}
	<div class="top">
		<span>{comments.open.length} open</span>
		{#if comments.resolved.length > 0}
			<button class="pill" onclick={() => (comments.showResolved = !comments.showResolved)}>
				{comments.showResolved ? 'Hide' : 'Show'} {comments.resolved.length} resolved
			</button>
		{/if}
	</div>
{/snippet}

<Edytor {value} plugins={[comments, ...plugins]} aria-label="Comments demo" />

<style>
	.note {
		padding: 10px 12px;
		border-radius: 4px 4px 12px 4px;
		background: #fff7d1;
		color: #4a4020;
		box-shadow: 0 4px 12px rgb(120 90 0 / 0.18);
		font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
		transform: rotate(-0.6deg);
	}
	.note[data-resolved='true'] {
		opacity: 0.7;
	}
	.quote {
		margin: 0 0 6px;
		font-style: italic;
		color: #8a7a30;
	}
	.comment {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 6px;
		padding: 2px 0 2px 8px;
		border-left: 3px solid var(--who);
		margin-bottom: 6px;
	}
	.comment span {
		flex: 1 1 8em;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.row {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
		margin-top: 6px;
	}
	button {
		font: inherit;
		cursor: pointer;
	}
	.quiet {
		border: 0;
		background: transparent;
		color: #8a7a30;
	}
	.pill {
		padding: 1px 10px;
		border: 1px solid #d8c76a;
		border-radius: 999px;
		background: #fffbe6;
		color: inherit;
		font-size: 12px;
	}
	.pill.go {
		background: #4a4020;
		border-color: #4a4020;
		color: #fff7d1;
	}
	.pill:disabled {
		opacity: 0.4;
		cursor: default;
	}
	textarea {
		box-sizing: border-box;
		width: 100%;
		margin-top: 4px;
		padding: 4px 8px;
		border: 1px solid #d8c76a;
		border-radius: 6px;
		background: #fffdf2;
		color: inherit;
		font: inherit;
		resize: vertical;
		outline: none;
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: #8a7a30;
	}
</style>
