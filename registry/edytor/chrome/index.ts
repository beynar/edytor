/**
 * The ready-made chrome (the `edytor-chrome` registry item): each bundled
 * plugin drawn with it, its snippets (`chrome`), its words and the version
 * history panel. The files are yours: edit them.
 */
export {
	chrome,
	slashMenu,
	slashMenuPlugin,
	blockMenu,
	blockMenuPlugin,
	toolbar,
	toolbarPlugin,
	blockHandles,
	blockHandlesPlugin,
	code,
	codePlugin,
	table,
	tablePlugin,
	equation,
	image,
	imagePlugin,
	imageToolbarPlugin,
	embed,
	embedPlugin,
	bookmark,
	bookmarkPlugin,
	richText,
	richTextPlugin,
	calloutIcons,
	calloutIconsPlugin,
	find,
	findPlugin,
	arrowMovePlugin,
	suggestionsPlugin,
	suggestionBarPlugin,
	comments,
	mention,
	pageLink,
	file,
	filePlugin,
	video,
	videoPlugin,
	audio,
	audioPlugin,
	mediaEmptyPlugin,
	marquee,
	marqueePlugin
} from './plugins.js';
export {
	words,
	setWords,
	englishWords,
	type ChromeWords,
	type PartialChromeWords
} from './words.svelte.js';
export { default as HistoryPanel } from './HistoryPanel.svelte';
