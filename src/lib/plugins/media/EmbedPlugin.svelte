<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import EmptySlot from './EmptySlot.svelte';
	import Control from '../Control.svelte';
	import type { Snippet } from 'svelte';
	import { urlPaste, type UrlPasteController } from './urlPaste.svelte.js';
	import {
		EMBED_ALLOW,
		EMBED_PROVIDERS,
		EMBED_SANDBOX,
		MEDIA_ICONS,
		claimed,
		embedSourceOf,
		escapeHtml,
		mediaControl,
		mediaLink,
		mediaPlugin,
		mediaView,
		safeWebUrl,
		type EmbedFallbackPayload,
		type EmbedProvider
	} from './media.js';

	export {
		EMBED_ALLOW,
		EMBED_PROVIDERS,
		EMBED_SANDBOX,
		embedSourceOf,
		type EmbedFallbackPayload,
		type EmbedProvider
	};

	export type EmbedPluginOptions = {
		/** The allowlist (default {@link EMBED_PROVIDERS}); a link none of them plays shows no frame. */
		providers?: readonly EmbedProvider[];
		/**
		 * The menu a URL pasted on an empty line opens (Link, Embed, Bookmark);
		 * it renders while `controller.open`, under the line (without it, the
		 * link is kept and nothing shows). The
		 * view's one menu takes the first `menu` its embed and bookmark
		 * plugins pass. Its keys stay the editor's; keep its ARIA with
		 * `{@attach controller.popup}` on the list and
		 * `{...controller.option(index)}` on each row.
		 */
		menu?: Snippet<[UrlPasteController]>;
		/**
		 * An embed whose link no allowed provider plays (a peer may store any),
		 * or a suggestion's preview: a plain link, never a frame (default: the
		 * URL as a link). Spread `fallback.link` on its `a`. The first embed
		 * plugin listed in a view gives it.
		 */
		fallback?: Snippet<[EmbedFallbackPayload]>;
	};

	/** The view's fallback markup, if the app gave one. */
	const fallbackOf = mediaControl('embed', 'fallback');

	/**
	 * The view's allowlist: the first embed plugin listed in it (first wins,
	 * as for the kind). Never a broader list: no entry plays nothing.
	 */
	const providers = (block: Block | undefined) =>
		mediaView(block?.edytor, 'embed')?.providers ?? [];

	/**
	 * Notion's embed block: an "Embed a link" panel until it has a link, then
	 * the provider's player in a sandboxed frame, with an editable caption.
	 * Only an allowlisted provider (`providers`) plays: the frame's `src` is
	 * the player URL the provider derives from the stored link, never the
	 * stored value, and it has a `sandbox` and no `srcdoc`. Void: its only
	 * text is the caption. Pasting a link a provider plays on an empty line
	 * offers "Embed".
	 */
	export const createEmbedPlugin = (options: EmbedPluginOptions = {}): Plugin => {
		const allowed = options.providers ?? EMBED_PROVIDERS;
		return mediaPlugin(
			'embed',
			['iframe', 'youtube', 'vimeo', 'loom', 'figma', 'codepen', 'spotify'],
			(edytor) => ({
				providers: allowed,
				fallback: options.fallback,
				// The block's link, when a provider plays it.
				store: (block, value) => {
					const url = safeWebUrl(value);
					if (!url || !embedSourceOf(url, allowed)) return 'invalid';
					block.edytor.patchData(block.id, [{ path: ['url'], value: url }]);
					return null;
				},
				hooks: urlPaste(
					edytor,
					{
						type: 'embed',
						icon: MEDIA_ICONS.embed,
						data: (url) => (embedSourceOf(url, allowed) ? { url } : null)
					},
					options.menu
				),
				record: {
					snippet: embed,
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
			})
		);
	};
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
			<Control
				own={fallbackOf}
				{initial}
				payload={{ block: block.handle, url, link: mediaLink(url) }}
			/>
		</div>
	{:else}
		<div use:block.void data-edytor-media-empty>
			<EmptySlot
				block={block.handle}
				kind="embed"
				viewOf={(edytor) => mediaView(edytor, 'embed')}
			/>
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}

<!-- The link itself. -->
{#snippet initial({ url, link }: EmbedFallbackPayload)}
	<a {...link}>{url}</a>
{/snippet}
