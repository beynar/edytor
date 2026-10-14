import { mount, unmount, type Snippet } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import Ranges, { runOf } from '$lib/components/Ranges.svelte';
import { hidden } from '$lib/selection/visibility.js';
import { FindController } from './FindController.svelte.js';
import { mountChrome } from '../chrome.js';

export type FindPluginOptions = {
	/**
	 * The bar's markup and its words; it renders while `find.isOpen`, placed at the
	 * editor's top right (without it, Mod+F searches and highlights, and
	 * nothing else shows). Put `{@attach find.field}` on your query input (focused
	 * on each Mod+F; Enter, Shift+Enter, Escape) and `{@attach find.replaceField}`
	 * on your replacement input.
	 */
	bar?: Snippet<[FindController]>;
};

const controllers = new WeakMap<Edytor, FindController>();

/** Matches highlighted at most: past it, the count still tells. */
const MAX_HIGHLIGHTS = 1000;

/** The find plugin's controller of `edytor`; `undefined` when the plugin is not listed. */
export const findController = (edytor: Edytor): FindController | undefined =>
	controllers.get(edytor);

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
		const find = new FindController(edytor);
		controllers.set(edytor, find);
		return {
			hotkeys: {
				// Over a text range in one line, search for it.
				'mod+f': ({ prevent }) => {
					const { startText, endText, yStart, yEnd } = edytor.selection.textRange();
					const { isCollapsed } = edytor.selection.projection;
					const selected =
						!isCollapsed && startText && startText === endText
							? startText.stringContent.slice(yStart, yEnd)
							: undefined;
					prevent(() => find.open(selected && !selected.includes('\n') ? selected : undefined));
				}
			},
			onEdytorAttached: () => {
				const layer = edytor.overlay.layer!;
				// Each shown match (at most `MAX_HIGHLIGHTS`: past it, the count still tells); one
				// in a closed toggle's body shows none until it is current, which opens the toggle.
				const highlights = mount(Ranges, {
					target: layer,
					props: {
						edytor,
						name: 'find-match',
						z: 18,
						ranges: () =>
							find.matches.slice(0, MAX_HIGHLIGHTS).flatMap(({ block, offset, length }, index) => {
								const shown = edytor.idToBlock.get(block);
								return shown && !hidden(shown)
									? runOf(edytor, block, offset, length, index === find.current)
									: [];
							})
					}
				});
				const unmountBar = mountChrome(edytor, options.bar, find, () => find.isOpen, {
					name: 'edytor-find-host',
					zIndex: 55
				});
				return () => {
					find.destroy();
					unmountBar();
					void unmount(highlights);
				};
			}
		};
	};
