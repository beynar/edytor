import { mount, unmount, type Snippet } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import FindBar from './FindBar.svelte';
import FindHighlights from './FindHighlights.svelte';
import { FindController } from './FindController.svelte.js';
import { labelsWith, type PartialLabels } from '$lib/labels.js';

export type FindPluginOptions = {
	/**
	 * Replace the bar's markup; it renders while `find.isOpen`, placed at the
	 * editor's top right. Put `use:find.field` on your query input (focused
	 * on each Mod+F; Enter, Shift+Enter, Escape) and `use:find.replaceField`
	 * on your replacement input.
	 */
	bar?: Snippet<[FindController]>;
	/** The words the bar shows, over the English ones. */
	labels?: PartialLabels<'find'>;
};

const controllers = new WeakMap<Edytor, FindController>();

/** The find plugin's controller of `edytor`; `undefined` when the plugin is not listed. */
export const findController = (edytor: Edytor): FindController | undefined =>
	controllers.get(edytor);

/** At the editor's top right, inside the viewport; measured in the overlay's frame (R11). */
const place = (edytor: Edytor, find: FindController) => (host: HTMLElement) => {
	const editor = edytor.node;
	const view = editor?.ownerDocument.defaultView;
	if (!editor || !view || !find.isOpen) return;
	const rect = editor.getBoundingClientRect();
	const width = host.firstElementChild?.getBoundingClientRect().width || 420;
	const right = Math.min(rect.right, view.innerWidth - 8);
	const left = `${Math.max(8, right - width)}px`;
	const top = `${Math.max(8, rect.top + 8)}px`;
	return () => Object.assign(host.style, { left, top });
};

/**
 * Find and replace (Notion's find in page), opt-in: Mod+F opens a bar over
 * the editor's top right. It searches the document's text in reading order,
 * a closed toggle's body included (the toggle opens when a match there
 * becomes the current one), highlights the matches in the overlay, and
 * replaces one or all as one command (`replaceMatches`) and one undo step.
 */
export const createFindPlugin =
	(options: FindPluginOptions = {}): Plugin =>
	(edytor) => {
		const find = new FindController(edytor, labelsWith('find', options.labels));
		controllers.set(edytor, find);
		return {
			hotkeys: {
				// Over a text range in one line, search for it.
				'mod+f': ({ prevent }) => {
					const { startText, endText, yStart, yEnd, isCollapsed } = edytor.selection.state;
					const selected =
						!isCollapsed && startText && startText === endText
							? startText.stringContent.slice(yStart, yEnd)
							: undefined;
					prevent(() => find.open(selected && !selected.includes('\n') ? selected : undefined));
				}
			},
			onEdytorAttached: () => {
				const layer = edytor.overlay.layer!;
				const highlights = mount(FindHighlights, { target: layer, props: { edytor, find } });
				const unmountBar = edytor.overlay.mount(
					FindBar,
					{ find, bar: options.bar },
					'edytor-find-host',
					55,
					place(edytor, find)
				);
				return () => {
					find.destroy();
					unmountBar();
					void unmount(highlights);
				};
			}
		};
	};

/** Find and replace with the built-in bar. */
export const findPlugin = createFindPlugin();
