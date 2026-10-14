<script module lang="ts">
	import { mediaForms } from '$lib/export/forms.js';
	import type { Plugin } from '$lib/plugins.js';
	import { source } from './SourceBlock.svelte';
	import type { Snippet } from 'svelte';
	import { urlPaste, type UrlPasteController } from './urlPaste.svelte.js';
	import {
		EMBED_ALLOW,
		EMBED_PROVIDERS,
		EMBED_SANDBOX,
		MEDIA_ICONS,
		embedSourceOf,
		mediaPlugin,
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
		 * `{@attach controller.option(index)}` on each row.
		 */
		menu?: Snippet<[UrlPasteController]>;
		/**
		 * An embed whose link no allowed provider plays (a peer may store any),
		 * or a suggestion's preview: a plain link, never a frame (default: the
		 * URL as a link): `<a href={fallback.url} {@attach fallback.link}>`. The first embed
		 * plugin listed in a view gives it.
		 */
		fallback?: Snippet<[EmbedFallbackPayload]>;
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
					snippet: source,
					...mediaForms(allowed).embed
				}
			})
		);
	};
</script>
