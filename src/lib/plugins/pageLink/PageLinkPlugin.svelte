<svelte:options runes />

<script module lang="ts">
	import { pageLinkForms } from '$lib/export/forms.js';
	import './pageLink.css';
	import type { Snippet } from 'svelte';
	import type {
		InlineBlockSnippetPayload,
		Plugin,
		PluginOperations,
		TriggerContext
	} from '$lib/plugins.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { TextAnchor } from '$lib/selection/selection.svelte.js';
	import type { TriggerMenuController } from '../triggers/TriggerController.svelte.js';
	import { placeAtom, withRulesAndTriggers } from '../triggers/triggers.js';
	import { pageLinkEnglish, labelsOf } from '$lib/labels.js';
	import { sanitizeLinkHref } from '../richtext/richTextOperations.js';

	/** A page the page-link menu offers: what your app's search answers. */
	export type PageLinkItem = {
		/** The page's id in your app: stored in the atom. */
		id: string;
		/** The page's title, shown in the menu and in the atom. */
		title: string;
		/** Where the link goes (absolute, or relative to your app); default `href(page)`. */
		href?: string;
		/** A short icon (an emoji) shown before the title. */
		icon?: string;
	};

	/** What a `pageLink` atom stores. */
	export type PageLinkData = { id: string; title: string; href?: string; icon?: string };

	export type PageLinkPluginOptions = {
		/** The pages matching `query` (the text typed after `[[`), at once or as a promise. */
		search: (
			query: string,
			ctx: TriggerContext
		) => readonly PageLinkItem[] | Promise<readonly PageLinkItem[]>;
		/** A page's URL when the search answers none (`/pages/<id>`, say). */
		href?: (page: PageLinkItem) => string | undefined;
		/**
		 * The page a pasted text names (your app's URL for it, `page:roadmap`…),
		 * at once or as a promise; `null` when it names none. Asked for a plain
		 * text paste at a caret that is one item (trimmed, one line): a page
		 * turns the pasted text into a `pageLink` atom, an undo step of its own
		 * after the paste, so undo gives the text back. A promise lets the paste
		 * land as it would without this option and swaps it when it answers, if
		 * the text is still there.
		 */
		fromPaste?: (
			text: string
		) => PageLinkItem | null | undefined | Promise<PageLinkItem | null | undefined>;
		/** The text that opens the menu (default `[[`). */
		char?: string;
		/**
		 * The menu's markup and its words; it renders while `controller.isOpen`,
		 * at the caret (without it, nothing shows). Keep its ARIA with `{@attach
		 * controller.popup}` on the list (name it) and
		 * `{...controller.option(index)}` on each row.
		 */
		menu?: Snippet<[TriggerMenuController<PageLinkItem>]>;
	};

	/** The atom for `page`, its href sanitized. */
	const atomOf = (page: PageLinkItem, options: PageLinkPluginOptions) => {
		const href = sanitizeLinkHref(page.href ?? options.href?.(page)) ?? undefined;
		const data: PageLinkData = {
			id: page.id,
			title: page.title,
			...(href ? { href } : {}),
			...(page.icon ? { icon: page.icon } : {})
		};
		return { type: 'pageLink', data };
	};

	const isPromise = <T,>(value: unknown): value is Promise<T> =>
		typeof (value as Promise<T> | null)?.then === 'function';

	/**
	 * Swap the pasted `item`, where the paste put it (right after `start`,
	 * past leading spaces), for `page`'s atom: one `autolink` step, so undo
	 * gives the text back. Nothing when the view is readonly or the text is
	 * no longer there; the caret follows the atom when it was at the text's end.
	 */
	const swapPasted = (
		edytor: Edytor,
		start: TextAnchor,
		item: string,
		page: PageLinkItem,
		options: PageLinkPluginOptions
	) => {
		if (edytor.readonly) return;
		const at = edytor.selection.resolveTextAnchor(start);
		if (!at) return;
		const { text } = at;
		const content = text.stringContent;
		let from = at.offset;
		while (from < content.length && /\s/.test(content[from])) from++;
		if (content.slice(from, from + item.length) !== item) return;
		const block = text.parent;
		const offset = text.segStart + from;
		const caret = edytor.selection.caret;
		const follows = caret?.block === block && caret.offset === offset + item.length;
		edytor.dispatcher.run('autolink', () => {
			if (edytor.deleteText(block.id, offset, item.length).status !== 'applied') return;
			edytor.insertInline(block.id, offset, atomOf(page, options));
			if (follows) edytor.dispatcher.caret({ block, offset: offset + 1 });
		});
	};

	/**
	 * The paste hook of `fromPaste` (it runs before the other plugins'
	 * `onPaste`, `pasteFirst`): a plain text paste at a caret in a text,
	 * outside islands and voids, that is one item. A page answered at once
	 * claims the paste (the text, then the swap); a promise claims nothing
	 * (the rich text link, the URL menu or the plain paste take it) and swaps
	 * what landed when it answers a page.
	 */
	const pasteHook = (edytor: Edytor, options: PageLinkPluginOptions): PluginOperations['onPaste'] =>
		options.fromPaste &&
		(({ e, prevent, at }) => {
			const { fromPaste } = options;
			if (!fromPaste || at || edytor.readonly) return;
			const plain = e.clipboardData?.getData('text/plain') ?? '';
			const item = plain.trim();
			if (!item || /[\r\n]/.test(item)) return;
			const { value, projection } = edytor.selection;
			if (value.kind !== 'text' || !projection.isCollapsed) return;
			if (projection.islandRoot !== null || projection.voidRoot !== null) return;
			const { startText: text, yStart } = edytor.selection.textRange();
			if (!text) return;
			const start = edytor.selection.createTextAnchor(text, yStart, 'left');
			if (!start) return;
			let answer: ReturnType<typeof fromPaste>;
			try {
				answer = fromPaste(item);
			} catch {
				return;
			}
			if (isPromise<PageLinkItem | null | undefined>(answer)) {
				answer.then(
					(page) => page && swapPasted(edytor, start, item, page, options),
					() => {}
				);
				return;
			}
			const page = answer;
			if (!page) return;
			prevent(() => {
				edytor.dispatcher.run('insertFromPaste', () => {
					edytor.insertText(text.parent.id, text.segStart + yStart, item);
					edytor.dispatcher.caret(text, yStart + item.length);
				});
				if (edytor.dispatcher.last?.status === 'applied')
					swapPasted(edytor, start, item, page, options);
			});
		});

	/**
	 * Links to your app's pages, as Notion's `[[`: it opens a menu of the pages
	 * your app's `search(query)` answers; picking one replaces `[[query` with
	 * a `pageLink` atom (`{ id, title, href, icon }`), an `<a>` to the page,
	 * and puts the caret after it, in one undo step. With `fromPaste`, a
	 * pasted text your app recognizes becomes a page link too.
	 */
	export const createPageLinkPlugin =
		(options: PageLinkPluginOptions): Plugin =>
		(edytor) =>
			withRulesAndTriggers(
				edytor,
				{
					...(edytor && options.fromPaste
						? { onPaste: pasteHook(edytor, options), pasteFirst: true }
						: {}),
					inlineBlocks: {
						pageLink: {
							...pageLinkForms(),
							snippet: pageLink
						}
					}
				},
				{
					triggers: [
						{
							char: options.char ?? '[[',
							items: (query, ctx) => options.search(query, ctx),
							label: (page: PageLinkItem) => page.title,
							key: (page: PageLinkItem) => page.id,
							menu: options.menu,
							onPick: (page: PageLinkItem, ctx) => placeAtom(ctx, atomOf(page, options))
						}
					]
				}
			);
</script>

{#snippet pageLink({ block }: InlineBlockSnippetPayload<Partial<PageLinkData>>)}
	<a
		class="edytor-page-link"
		data-selected={block.selected ? 'true' : undefined}
		href={sanitizeLinkHref(block.data.href) ?? undefined}
		data-edytor-page-link
		data-page-id={block.data.id}
		><span class="icon" aria-hidden="true">{block.data.icon ?? '📄'}</span><span class="title"
			>{block.data.title ??
				labelsOf(block.handle?.edytor, 'pageLink', pageLinkEnglish).untitled}</span
		></a
	>
{/snippet}
