<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import MediaEmpty from './MediaEmpty.svelte';
	import { mediaKinds } from '$lib/crdt/semantics.js';
	import type { Snippet } from 'svelte';
	import { urlPaste, type UrlPasteController } from './urlPaste.svelte.js';
	import type { MediaEmptyController } from './empty.svelte.js';
	import { keywordsOf, labelsWith, type PartialLabels } from '$lib/labels.js';
	import {
		EMBED_ALLOW,
		EMBED_PROVIDERS,
		EMBED_SANDBOX,
		claimed,
		embedSourceOf,
		mediaLabels,
		mediaEmpty,
		escapeHtml,
		safeWebUrl,
		type EmbedProvider
	} from './media.js';

	export { EMBED_ALLOW, EMBED_PROVIDERS, EMBED_SANDBOX, embedSourceOf, type EmbedProvider };

	export type EmbedPluginOptions = {
		/** The allowlist (default {@link EMBED_PROVIDERS}); a link none of them plays shows no frame. */
		providers?: readonly EmbedProvider[];
		/** The words the block shows (its empty panel, its menu row), over the English ones. */
		labels?: PartialLabels<'media'>;
		/** The slash menu's keywords of its command (`block.<kind>`), which replace its own. */
		keywords?: Partial<Record<string, string[]>>;
		/**
		 * Replace the menu a URL pasted on an empty line opens (Link, Embed,
		 * Bookmark); it renders while `controller.open`, under the line. The
		 * view's one menu takes the first `menu` its embed and bookmark
		 * plugins pass. Its keys stay the editor's; keep its ARIA with
		 * `{@attach controller.popup}` on the list and
		 * `{...controller.option(index)}` on each row.
		 */
		menu?: Snippet<[UrlPasteController]>;
		/**
		 * Replace an empty block's markup (its "Add …" button and link panel,
		 * or a readonly view's placeholder): it receives the block's
		 * `MediaEmptyController` (`open`, `draft`, `failed`, `embed`, `readonly`).
		 */
		empty?: Snippet<[MediaEmptyController]>;
	};

	const providersOf = new WeakMap<Edytor, readonly EmbedProvider[]>();
	/**
	 * The view's allowlist: the first embed plugin listed in it (first wins,
	 * as for the kind). Never a broader list: no entry plays nothing.
	 */
	const providers = (block: Block | undefined) => (block && providersOf.get(block.edytor)) ?? [];

	/** Store `value` as the block's link when a provider plays it; answers whether it did. */
	const embedLink = (block: Block | undefined, value: string) => {
		const url = safeWebUrl(value);
		if (!block || !url || !embedSourceOf(url, providers(block))) return false;
		block.data.url = url;
		return true;
	};

	/**
	 * Notion's embed block: an "Embed a link" panel until it has a link, then
	 * the provider's player in a sandboxed frame, with an editable caption.
	 * Only an allowlisted provider (`providers`) plays: the frame's `src` is
	 * the player URL the provider derives from the stored link, never the
	 * stored value, and it has a `sandbox` and no `srcdoc`. Void: its only
	 * text is the caption. Pasting a link a provider plays on an empty line
	 * offers "Embed".
	 */
	export const createEmbedPlugin =
		(options: EmbedPluginOptions = {}): Plugin =>
		(edytor) => {
			const allowed = options.providers ?? EMBED_PROVIDERS;
			if (!providersOf.has(edytor)) providersOf.set(edytor, allowed);
			const labels = labelsWith('media', options.labels);
			mediaLabels.embed.claim(edytor, labels);
			mediaEmpty.claim(edytor, 'embed', options.empty);
			return {
				...urlPaste(
					edytor,
					{
						type: 'embed',
						label: labels.embed.offer,
						icon: '⧉',
						data: (url) => (embedSourceOf(url, allowed) ? { url } : null)
					},
					labels,
					options.menu
				),
				blocks: {
					embed: {
						...mediaKinds.embed,
						snippet: embed,
						element: 'figure',
						presets: [
							{
								label: labels.embed.label,
								icon: '⧉',
								keywords: keywordsOf(
									'block.embed',
									['iframe', 'youtube', 'vimeo', 'loom', 'figma', 'codepen', 'spotify'],
									options.keywords
								),
								group: 'Media'
							}
						],
						html: (block, caption) => {
							const player = embedSourceOf(block.data?.url, allowed);
							const url = safeWebUrl(block.data?.url);
							const media = player
								? `<iframe src="${escapeHtml(player.src)}" title="${escapeHtml(player.provider.name)}" sandbox="${EMBED_SANDBOX}" allowfullscreen></iframe>`
								: url
									? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
									: '';
							return `<figure>${media}<figcaption>${caption}</figcaption></figure>`;
						},
						plain: (block, caption) =>
							[safeWebUrl(block.data?.url), caption].filter(Boolean).join('\n'),
						// An allowlisted `iframe` (bare, or in a `figure`): its `src` is the link.
						parse: (el) => {
							const src = claimed(el, 'iframe')?.getAttribute('src');
							const url = embedSourceOf(src, allowed) && safeWebUrl(src);
							return url ? { url } : undefined;
						}
					}
				}
			};
		};

	/** The embed block with the default providers. */
	export const embedPlugin = createEmbedPlugin();
</script>

{#snippet embed({ block, content }: BlockSnippetPayload<{ url?: string }>)}
	{@const player = block.handle ? embedSourceOf(block.data.url, providers(block.handle)) : null}
	{@const url = safeWebUrl(block.data.url)}
	{#if player}
		{@const { height, aspectRatio = '16 / 9' } = player.provider}
		<div
			use:block.void
			data-edytor-embed
			style:aspect-ratio={height ? undefined : aspectRatio}
			style:height={height ? `${height}px` : undefined}
		>
			<iframe
				src={player.src}
				title={player.provider.name}
				sandbox={EMBED_SANDBOX}
				allow={EMBED_ALLOW}
				referrerpolicy="strict-origin-when-cross-origin"
				loading="lazy"
				allowfullscreen
				style="display: block; width: 100%; height: 100%; border: 0"
			></iframe>
		</div>
	{:else if url}
		<!-- A link no provider plays (a peer may store any), or a suggestion's preview (no handle, so no
		view's allowlist): a plain link, never a frame. -->
		<div use:block.void data-edytor-embed-unsupported>
			<a href={url} target="_blank" rel="noopener noreferrer nofollow">{url}</a>
		</div>
	{:else}
		<div use:block.void data-edytor-media-empty>
			<MediaEmpty
				block={block.handle}
				kind="embed"
				icon="⧉"
				link={(value) => embedLink(block.handle, value)}
			/>
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}
