/**
 * What every plugin demo shares: the editor around the page's plugin (the
 * demo's chrome, copied into `site/chrome` by `scripts/pack-edytor.sh`) and
 * the local stand-ins for an app's services. Nothing here reaches a server.
 */
import { richTextPlaceholder, type Plugin, type Uploader } from 'edytor';
import {
	arrowMovePlugin,
	blockHandlesPlugin,
	blockMenuPlugin,
	richTextPlugin,
	slashMenuPlugin,
	toolbarPlugin
} from 'edytor/starter';

/**
 * The editor around a demo: Notion's hints in empty blocks, the block
 * handles and their menu, block moves from the keyboard, the slash menu,
 * the selection toolbar and rich text. List the page's own plugins before these. A page whose Customize
 * component configures one of them passes it (`basePlugins(toolbarPlugin)`)
 * to leave the demo's instance out: one view holds one of each.
 */
export const basePlugins = (...without: Plugin[]): Plugin[] =>
	[
		() => ({ placeholder: richTextPlaceholder }),
		blockHandlesPlugin,
		blockMenuPlugin,
		arrowMovePlugin,
		slashMenuPlugin,
		toolbarPlugin,
		richTextPlugin
	].filter((plugin) => !without.includes(plugin));

/** An uploader that keeps the file in this tab: its object URL, gone on reload. */
export const objectUrlUpload: Uploader = async (file, report) => {
	report.progress(1);
	return URL.createObjectURL(file);
};

/** A search over a fixed list: what an app's directory or page search would answer. */
export const searchBy =
	<T>(items: readonly T[], text: (item: T) => string) =>
	(query: string): T[] =>
		items.filter((item) => text(item).toLowerCase().includes(query.trim().toLowerCase()));
