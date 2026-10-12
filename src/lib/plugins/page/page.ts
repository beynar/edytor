import type { Snippet } from 'svelte';
import type { Block } from '$lib/block/block.svelte.js';
import type { Attachment } from 'svelte/attachments';
import { sanitizeLinkHref } from '../richtext/richTextOperations.js';
import { escapeHtml } from '$lib/clipboard/serializeClipboardFragment.js';

/** The page plugin's options: how your app opens, names, links and creates pages. */
export type PagePluginOptions = {
	/**
	 * Open the page (navigate to it): a click on a page block, or Enter over
	 * it selected alone; `newTab` for a modified click (Mod, Shift) or a
	 * middle click, which a link (`href`) leaves to the browser. Without it
	 * the block is a plain link when `href` gives one, else inert.
	 */
	open?: (pageId: string, how: { newTab: boolean }) => void;
	/**
	 * The page's title now, or a promise of it; `null` or `undefined` while
	 * unknown (the block shows the title it stores). Read from reactive
	 * state, the block follows renames. An answer that differs from the
	 * stored title is stored, outside the undo history, so views and
	 * exports without a lookup show it too.
	 */
	title?: (pageId: string) => string | null | undefined | Promise<string | null | undefined>;
	/** A URL for the page: the block is a link to it (a modified click opens a new tab), and its HTML export links it. */
	href?: (pageId: string) => string;
	/**
	 * Create a new page and answer its id (and its title): the "Page"
	 * command (slash menu, `+`) inserts a block linking to it, then opens
	 * it. Without it there is no such command; insert page blocks yourself.
	 */
	create?: () => string | { pageId: string; title?: string } | null | undefined;
	/**
	 * The block's link to its page (default: Notion's row, a page icon and
	 * the title). Give an `a` (`href={link.href}`) when `link.href` is set,
	 * else a `button`, `{@attach link.control}`: a click opens the page
	 * (`open`), a modified or middle click in a new tab. The first page plugin listed in a view
	 * gives it.
	 */
	link?: Snippet<[PageBlockLinkPayload]>;
};

/** What a page block's `link` snippet receives: the page it links to. */
export type PageBlockLinkPayload = {
	/** The page block; `undefined` in a suggestion's preview (it opens nothing). */
	block: Block | undefined;
	/** The page's id (`null`: the block names none). */
	pageId: string | null;
	/** Its title: your `title` lookup's answer, else the one the block stores. */
	title: string | undefined;
	/** What it reads: its title, else the view's `page.untitled`. */
	label: string;
	/** The page's URL (`href`), if any: draw an `a`. */
	href: string | undefined;
	/** A click may open it: it names a page and the plugin has `open`. */
	openable: boolean;
	/** Open the page (`open`), in a new tab when `newTab`. */
	open: (newTab?: boolean) => void;
	/**
	 * The link's attachment (`{@attach link.control}`): its marker
	 * (`data-edytor-page-link`), the click and middle click that open it; on
	 * an `a`, `draggable="false"`; on a `button`, `disabled` when it cannot
	 * open and a press that keeps the editor's selection.
	 */
	control: Attachment<HTMLElement>;
};

/** Each view's page options (the first page plugin listed sets them). */
export const pageOptions = new WeakMap<object, PagePluginOptions>();

/** A stored page id: a non-empty string of at most 256 characters (a room id's bounds), else `null`. */
export const pageIdOf = (value: unknown): string | null =>
	typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;

/** A title as a page block stores and shows it: trimmed, at most 300 characters, never empty. */
export const pageTitleOf = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined;

/**
 * The title cache's writes: background bookkeeping, not a gesture, so no
 * view's history tracks this origin (an undo never brings back a stale title).
 */
const TITLE_ORIGIN = Symbol('edytor.page.title');

/**
 * Store `title` as `block`'s cached title, when the block still links to
 * `pageId` in a view that may write: one data write outside the history.
 */
export const storePageTitle = (block: Block, pageId: string, title: string) => {
	const { edytor, id } = block;
	if (edytor.readonly || !edytor.dispatcher.permits() || !block.isInTree) return;
	const data = edytor.facade.blockDataOf(id);
	if (block.type !== 'page' || data?.pageId !== pageId || data?.title === title) return;
	edytor.doc.transact(
		() =>
			edytor.facade.apply(edytor.facade.prepare.patchData(id, [{ path: ['title'], value: title }])),
		TITLE_ORIGIN
	);
};

/** `options.href`'s URL for `pageId`, through the link sanitizer (no script URL), else `undefined`. */
export const pageHref = (options: PagePluginOptions, pageId: string | null) =>
	(pageId && options.href && sanitizeLinkHref(options.href(pageId))) || undefined;

/**
 * A page block's HTML export: a paragraph naming the page, its title linked
 * by `href`, `untitled` without one.
 */
export const pageHtml = (
	data: Record<string, unknown> | undefined,
	options: PagePluginOptions,
	untitled: string
) => {
	const pageId = pageIdOf(data?.pageId);
	if (!pageId) return '';
	const title = escapeHtml(pageTitleOf(data?.title) ?? untitled);
	const href = pageHref(options, pageId);
	const body = href ? `<a href="${escapeHtml(href)}">${title}</a>` : title;
	return `<p data-edytor-page="${escapeHtml(pageId)}">${body}</p>`;
};
