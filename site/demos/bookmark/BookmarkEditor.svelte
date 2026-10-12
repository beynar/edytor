<script lang="ts">
	import {
		Edytor,
		createBookmarkPlugin,
		type BookmarkCardPayload,
		type BookmarkPreview,
		type JSONDoc,
		type Plugin
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// A stand-in for your server: canned metadata after a short delay.
	const unfurl = async (url: string): Promise<BookmarkPreview> => {
		await new Promise((resolve) => setTimeout(resolve, 400));
		const host = new URL(url).hostname.replace(/^www\./, '');
		return {
			title: `A page on ${host}`,
			description: `Canned metadata for ${host}: the title and this line come from the demo, not from the page.`
		};
	};

	// Bookmarks drawn with the card below.
	const bookmarks = createBookmarkPlugin({ unfurl, card });

	const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');
</script>

<!-- A ticket: the host as a tab, the title large, an arrow that moves on hover. -->
{#snippet card(page: BookmarkCardPayload)}
	<a class="card" href={page.url} {@attach page.link}>
		<span class="host">{hostOf(page.url)}</span>
		<strong>{page.title ?? page.url}</strong>
		{#if page.description}<span class="about">{page.description}</span>{/if}
		<span class="go" aria-hidden="true">↗</span>
	</a>
{/snippet}

<Edytor {value} plugins={[bookmarks, ...plugins]} aria-label="Bookmark demo" />

<style>
	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 14px 44px 14px 18px;
		border: 1px solid #e3d5b8;
		border-left: 5px solid #d98e04;
		border-radius: 4px 12px 12px 4px;
		background: #fffaf0;
		color: #3b2f14;
		text-decoration: none;
	}
	.host {
		font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #a86c00;
	}
	strong {
		font-size: 16px;
		line-height: 1.3;
	}
	.about {
		font-size: 13px;
		line-height: 1.4;
		color: #6b5a36;
	}
	.go {
		position: absolute;
		top: 12px;
		right: 16px;
		font-size: 18px;
		color: #d98e04;
		transition: transform 0.15s;
	}
	.card:hover {
		background: #fff3d6;
	}
	.card:hover .go {
		transform: translate(2px, -2px);
	}
</style>
