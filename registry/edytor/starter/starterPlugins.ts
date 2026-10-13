/**
 * The plugin list of a starter editor: every useful bundled plugin, drawn
 * with the ready-made chrome (`chrome/plugins.ts`), each on or off and
 * configured by its key in `plugins`.
 */
import {
	createArrowMovePlugin,
	createColumnsPlugin,
	createImageToolbarPlugin,
	createMarkdownShortcutsPlugin,
	createMediaEmptyPlugin,
	createSuggestionBarPlugin,
	createSuggestionsPlugin,
	createTocPlugin,
	richTextPlaceholder,
	type CommentsClient,
	type PageLinkItem,
	type Plugin,
	type Uploader
} from 'edytor';
import * as chrome from '../chrome/plugins.js';
import type { StarterPerson, StarterPluginOptions, StarterPlugins } from './types.js';

type Key = keyof StarterPluginOptions;

const matching = (query: string, text: string) =>
	text.toLowerCase().includes(query.trim().toLowerCase());

/** The options of `key`: `undefined` when it is off, else the app's object (or `{}`). */
const optionsOf = <K extends Key>(
	plugins: StarterPlugins,
	key: K
): Partial<StarterPluginOptions[K]> | undefined => {
	const given: unknown = plugins[key];
	if (given === false) return undefined;
	if (given === true || given === undefined) return {};
	return given as Partial<StarterPluginOptions[K]>;
};

export type StarterPluginInput = {
	plugins?: StarterPlugins;
	extraPlugins?: Plugin[];
	upload?: Uploader;
	people?: readonly StarterPerson[];
	pages?: readonly PageLinkItem[];
	/** The comment threads' store; none: no comments. */
	comments?: CommentsClient | false;
	/** The current user's id among `people` (default the first person). */
	user?: string;
};

/** The plugins of a starter editor, the app's `extraPlugins` first. */
export const starterPlugins = ({
	plugins = {},
	extraPlugins = [],
	upload,
	people = [],
	pages,
	comments,
	user
}: StarterPluginInput): Plugin[] => {
	const list: Plugin[] = [...extraPlugins];
	const on = <K extends Key>(
		key: K,
		make: (options: Partial<StarterPluginOptions[K]>) => Plugin
	) => {
		const options = optionsOf(plugins, key);
		if (options) list.push(make(options));
	};
	const withUpload = <T extends { upload?: Uploader }>(options: T): T =>
		upload && !options.upload ? { ...options, upload } : options;

	on('placeholder', () => () => ({ placeholder: richTextPlaceholder }));
	on('blockHandles', (options) => chrome.blockHandles(options));
	on('arrowMove', () => createArrowMovePlugin());
	on('image', (options) => chrome.image(withUpload(options)));
	on('file', (options) => chrome.file(withUpload(options)));
	on('video', (options) => chrome.video(withUpload(options)));
	on('audio', (options) => chrome.audio(withUpload(options)));
	on('mediaEmpty', () => createMediaEmptyPlugin({ empty: chrome.chrome.mediaEmpty }));
	on('imageToolbar', () => createImageToolbarPlugin({ toolbar: chrome.chrome.imageToolbar }));
	on('embed', (options) => chrome.embed(options));
	on('bookmark', (options) => chrome.bookmark(options));
	on('code', (options) => chrome.code(options));
	on('markdownShortcuts', () => createMarkdownShortcutsPlugin());
	on('mention', (options) =>
		chrome.mention({
			items: (query) => people.filter((person) => matching(query, person.label)),
			...options
		})
	);
	const pageLink = optionsOf(plugins, 'pageLink');
	if (pageLink && (pageLink.search || pages)) {
		const all = pages ?? [];
		list.push(
			chrome.pageLink({
				search: (query) => all.filter((page) => matching(query, page.title)),
				...pageLink
			})
		);
	}
	on('slashMenu', (options) => chrome.slashMenu(options));
	on('toolbar', (options) => chrome.toolbar(options));
	on('blockMenu', (options) => chrome.blockMenu(options));
	on('columns', () => createColumnsPlugin());
	on('find', (options) => chrome.find(options));
	on('marquee', (options) => chrome.marquee({ container: '[data-edytor-starter]', ...options }));
	on('toc', () => createTocPlugin());
	on('table', (options) => chrome.table(options));
	on('equation', (options) => chrome.equation(options));
	on('suggestions', () => createSuggestionsPlugin());
	on('suggestionBar', () => createSuggestionBarPlugin({ bar: chrome.chrome.suggestionBar }));
	on('calloutIcons', (options) => chrome.calloutIcons(options));
	on('richText', (options) => chrome.richText(options));
	if (comments) {
		const person = (id: string) => people.find((one) => one.id === id);
		const named = (id: string) => {
			const one = person(id);
			return one
				? { name: one.label, avatar: typeof one.avatar === 'string' ? one.avatar : undefined }
				: undefined;
		};
		const me = user ?? people[0]?.id ?? 'me';
		on('comments', (options) =>
			chrome.comments({
				client: comments,
				user: { id: me, ...named(me) },
				users: named,
				...options
			})
		);
	}
	return list;
};
