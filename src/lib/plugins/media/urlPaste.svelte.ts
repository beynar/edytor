import type { Snippet } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import type { PluginDefinitions, PluginOperations } from '$lib/plugins.js';
import type { SerializableContent } from '$lib/utils/json.js';
import { dispatchPlan } from '$lib/block/block.utils.js';
import { placeNear } from '$lib/surface/overlay.js';
import { onPress } from '$lib/events/onFocus.js';
import { holdsNothing, lineage, placing } from '$lib/kinds.js';
import { id } from '$lib/utils.js';
import { pastedLink } from '../richtext/richTextOperations.js';
import { safeWebUrl } from './media.js';
import { inPage, mountChrome, optionAttributes, type OptionAttributes } from '../chrome.js';
import { listHotkeys, listPopup } from '../list.svelte.js';

/** A kind a pasted URL can turn its line into (the embed's, the bookmark's). */
export type UrlPasteOffer = {
	/** The kind the line becomes. */
	type: string;
	icon: string;
	/** The block's data for `url`, or `null` when this kind takes no such URL (no provider plays it). */
	data: (url: string) => Record<string, SerializableContent> | null;
	/** After the line became the kind (a bookmark's unfurl). */
	created?: (block: Block, url: string) => void;
};

/** One row of the menu: keep the link (`link`), or an offer (its kind). */
export type UrlPasteOption = { id: string; icon: string; offer?: UrlPasteOffer };

/**
 * Pasting a bare URL on an empty line (Notion): the URL lands as a link at
 * once (one `insertFromPaste` step, its own undo step) and a menu under the
 * line offers to keep it ("Link", the highlighted row) or to turn the line
 * into a kind an offer names (`Embed`, `Bookmark`), one `setBlock` command
 * (its own undo step, which gives the link back). Anything but a pick
 * closes the menu and keeps the link: Escape, a press outside, an
 * operation, a caret that leaves the URL's end, readonly.
 *
 * One controller per view, shared by the plugins that make offers: the
 * first one listed carries its hooks (`urlPaste`).
 */
export class UrlPasteController {
	readonly offers: UrlPasteOffer[] = [];
	/** The open menu: the line, the URL, the rows. */
	open = $state<{ block: string; url: string; options: UrlPasteOption[] } | null>(null);
	/** The keyboard's row. */
	index = $state(0);

	constructor(readonly edytor: Edytor) {
		this.popup = listPopup(
			edytor,
			'url-paste',
			'listbox',
			(node) => this.open && { active: inPage(node, this.optionId(this.index)) }
		);
	}

	get readonly() {
		return this.edytor.readonly;
	}

	/** A custom menu (a media plugin's `menu`): the first one a plugin making an offer passed. */
	#menu: Snippet<[UrlPasteController]> | undefined;

	/** Take `menu` as the view's menu, unless a plugin listed before passed one. @internal */
	claimMenu(menu: Snippet<[UrlPasteController]> | undefined) {
		this.#menu ??= menu;
	}

	/** The listbox's element id (page-unique), for `aria-controls`. */
	get listId() {
		return this.edytor.popups.idOf('url-paste');
	}

	/** The element id of the row at `index` (page-unique), for `aria-activedescendant`. */
	optionId = (index: number) => this.edytor.popups.idOf(`url-paste-option-${index}`);

	/**
	 * The attributes of the row at `index`: spread them on its element
	 * (`{...controller.option(index)}`): its id, `role="option"`,
	 * `aria-selected` and `data-selected` for the keyboard's row.
	 */
	option = (index: number): OptionAttributes =>
		optionAttributes(this.optionId(index), 'option', index === this.index);

	/**
	 * The listbox (`{@attach controller.popup}`, named by your markup): it
	 * takes the menu's id and its `listbox` role unless it has its own, keeps the editor's focus
	 * on a press, and is published to the view's root (`edytor.popups`) with
	 * its highlighted row while the menu is open: the editor keeps the
	 * keyboard (its keys move and pick).
	 */
	popup: Attachment<HTMLElement>;

	/** The rows for `url`: Link, then each offer that takes it. @internal */
	optionsFor = (url: string): UrlPasteOption[] => [
		{ id: 'link', icon: '🔗' },
		...this.offers.flatMap((offer) =>
			offer.data(url) ? [{ id: offer.type, icon: offer.icon, offer }] : []
		)
	];

	/**
	 * The paste (plugin `onPaste`, so a Shift+paste never reaches it): a
	 * caret on a line that holds nothing, outside islands and voids, and
	 * plain text that is one `http(s)` URL some offer takes.
	 * @internal
	 */
	paste: NonNullable<PluginOperations['onPaste']> = ({ e, prevent }) => {
		const { edytor } = this;
		const { selection } = edytor;
		if (selection.value.kind !== 'text' || !selection.projection.isCollapsed) return;
		const { projection } = selection;
		if (projection.islandRoot !== null || projection.voidRoot !== null) return;
		const { startText: text } = selection.textRange();
		const block = text?.parent;
		if (!block?.convertible || !text || !holdsNothing(edytor, block)) return;
		const url = safeWebUrl(pastedLink(e.clipboardData?.getData('text/plain')));
		const options = url ? this.optionsFor(url) : [];
		if (!url || options.length < 2) return;
		prevent(() => {
			this.close();
			const marks: Record<string, SerializableContent> = edytor.marks.has('link')
				? { link: { href: url } }
				: {};
			edytor.dispatcher.run('insertFromPaste', () => {
				text.insertText({ value: url, start: 0, end: 0, marks });
				edytor.dispatcher.caret(edytor.idToBlock.get(block.id)?.firstText, url.length);
			});
			if (edytor.dispatcher.last?.status !== 'applied') return;
			this.open = { block: block.id, url, options };
			this.index = 0;
			edytor.overlay.invalidate();
		});
	};

	close = () => {
		if (this.open) this.open = null;
	};

	/** Move the keyboard's row; answers whether the menu took the key. */
	move = (step: number) => {
		if (!this.open) return false;
		const count = this.open.options.length;
		this.index = (this.index + step + count) % count;
		return true;
	};

	/** The caret still rests at the end of the pasted URL, in its line. @internal */
	stays = () => {
		const { open, edytor } = this;
		const { value, projection } = edytor.selection;
		return Boolean(
			open &&
			value.kind === 'text' &&
			projection.isCollapsed &&
			projection.start?.block === open.block &&
			projection.start.offset === open.url.length
		);
	};

	/** Pick a row: keep the link, or turn the line into the offer's kind. */
	pick = (option: UrlPasteOption | undefined = this.open?.options[this.index]) => {
		const open = this.open;
		this.close();
		const offer = option?.offer;
		if (!open || !offer) return;
		const { edytor } = this;
		const block = edytor.idToBlock.get(open.block);
		const data = offer.data(open.url);
		if (!block?.isInTree || !block.convertible || !data) return;
		const value = { type: offer.type, data, content: [] };
		const applied = dispatchPlan(
			block,
			'setBlock',
			{ value },
			(p) => placing(block, p.value, false, id('b')),
			lineage(block)
		);
		const converted = applied && edytor.idToBlock.get(block.id);
		if (!converted) return;
		edytor.dispatcher.caret(converted.firstText, 0);
		offer.created?.(converted, open.url);
	};

	/** The hooks of the plugin carrying the menu. @internal */
	hooks = (): PluginOperations & PluginDefinitions => ({
		onPaste: this.paste,
		hotkeys: listHotkeys(
			() => this.open !== null && { move: this.move, pick: () => this.pick(), close: this.close }
		),
		onAfterOperation: () => this.close(),
		onSelectionChange: () => {
			if (this.open && !this.stays()) this.close();
		},
		onEdytorAttached: ({ node }) => {
			const outside = (event: MouseEvent) => {
				const target = event.target as Element | null;
				if (!target?.closest?.('[data-edytor-url-paste-host]')) this.close();
			};
			const offPress = onPress(this.edytor, node.ownerDocument, outside, true);
			const unmount = mountChrome(
				this.edytor,
				this.#menu,
				this,
				() => this.open,
				{ name: 'edytor-url-paste-host', zIndex: 50, measure: this.measure },
				this.close
			);
			return () => {
				offPress();
				unmount();
				this.close();
			};
		}
	});

	/** Under the pasted line, kept in the viewport; a gone line closes the menu. @internal */
	measure = (host: HTMLElement) => {
		const { open, edytor } = this;
		if (!open) return;
		const block = edytor.idToBlock.get(open.block);
		if (!block?.isInTree) return () => this.close();
		const rect = (block.firstText?.node ?? block.node)?.getBoundingClientRect();
		return rect && placeNear(host, rect, [220, 120], { gap: 4 });
	};
}

const controllers = new WeakMap<Edytor, UrlPasteController>();

/**
 * Register `offer` on `edytor`'s URL paste menu. The first plugin to offer
 * gets the menu's hooks to return (its paste, keys and overlay); the others
 * get none, so one view has one menu whatever the plugins listed. One offer
 * per kind: the first listed wins, as its definition does (a plugin listed
 * twice offers once). The menu's markup is the first `menu` passed.
 */
export const urlPaste = (
	edytor: Edytor,
	offer: UrlPasteOffer,
	menu?: Snippet<[UrlPasteController]>
): PluginOperations & PluginDefinitions => {
	const known = controllers.get(edytor);
	if (known) {
		if (!known.offers.some(({ type }) => type === offer.type)) known.offers.push(offer);
		known.claimMenu(menu);
		return {};
	}
	const controller = new UrlPasteController(edytor);
	controllers.set(edytor, controller);
	controller.offers.push(offer);
	controller.claimMenu(menu);
	return controller.hooks();
};
