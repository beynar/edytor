import type { Edytor } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import type { PluginDefinitions, PluginOperations } from '$lib/plugins.js';
import type { SerializableContent } from '$lib/utils/json.js';
import { dispatchPlan } from '$lib/block/block.utils.js';
import { onPress } from '$lib/events/onFocus.js';
import { holdsNothing, lineage, placing } from '$lib/kinds.js';
import { id } from '$lib/utils.js';
import { pastedLink } from '../richtext/richTextOperations.js';
import { safeWebUrl } from './media.js';
import UrlPasteMenu from './UrlPasteMenu.svelte';

/** A kind a pasted URL can turn its line into (the embed's, the bookmark's). */
export type UrlPasteOffer = {
	/** The kind the line becomes. */
	type: string;
	/** The menu row. */
	label: string;
	icon: string;
	/** The block's data for `url`, or `null` when this kind takes no such URL (no provider plays it). */
	data: (url: string) => Record<string, SerializableContent> | null;
	/** After the line became the kind (a bookmark's unfurl). */
	created?: (block: Block, url: string) => void;
};

/** One row of the menu: keep the link, or an offer. */
export type UrlPasteOption = { id: string; label: string; icon: string; offer?: UrlPasteOffer };

const LINK: UrlPasteOption = { id: 'link', label: 'Link', icon: '🔗' };

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

	constructor(readonly edytor: Edytor) {}

	get readonly() {
		return this.edytor.readonly;
	}

	/** The rows for `url`: Link, then each offer that takes it. */
	optionsFor = (url: string): UrlPasteOption[] => [
		LINK,
		...this.offers.flatMap((offer) =>
			offer.data(url) ? [{ id: offer.type, label: offer.label, icon: offer.icon, offer }] : []
		)
	];

	/**
	 * The paste (plugin `onPaste`, so a Shift+paste never reaches it): a
	 * caret on a line that holds nothing, outside islands and voids, and
	 * plain text that is one `http(s)` URL some offer takes.
	 */
	paste: NonNullable<PluginOperations['onPaste']> = ({ e, prevent }) => {
		const { edytor } = this;
		const { selection } = edytor;
		if (selection.value.kind !== 'text' || !selection.state.isCollapsed) return;
		const { projection } = selection;
		if (projection.islandRoot !== null || projection.voidRoot !== null) return;
		const { startBlock: block, startText: text } = selection.state;
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

	/** The caret still rests at the end of the pasted URL, in its line. */
	stays = () => {
		const { open, edytor } = this;
		const { value, state } = edytor.selection;
		return Boolean(
			open &&
			value.kind === 'text' &&
			state.isCollapsed &&
			state.startBlock?.id === open.block &&
			(state.startText?.segStart ?? 0) + state.yStart === open.url.length
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

	/** The hooks of the plugin carrying the menu. */
	hooks = (): PluginOperations & PluginDefinitions => ({
		onPaste: this.paste,
		hotkeys: {
			arrowdown: ({ prevent }) => {
				if (this.move(1)) prevent();
			},
			arrowup: ({ prevent }) => {
				if (this.move(-1)) prevent();
			},
			enter: ({ prevent }) => {
				if (this.open) prevent(() => this.pick());
			},
			escape: ({ prevent }) => {
				if (this.open) prevent(() => this.close());
			}
		},
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
			const unmount = this.edytor.overlay.mount(
				UrlPasteMenu,
				{ controller: this },
				'edytor-url-paste-host',
				50,
				this.measure
			);
			return () => {
				offPress();
				unmount();
				this.close();
			};
		}
	});

	/** Under the pasted line, kept in the viewport; a gone line closes the menu. */
	measure = (host: HTMLElement) => {
		const { open, edytor } = this;
		if (!open) return;
		const block = edytor.idToBlock.get(open.block);
		if (!block?.isInTree) return () => this.close();
		const view = host.ownerDocument.defaultView;
		const rect = (block.firstText?.node ?? block.node)?.getBoundingClientRect();
		if (!view || !rect) return;
		const width = host.firstElementChild?.getBoundingClientRect().width || 220;
		const height = host.firstElementChild?.getBoundingClientRect().height || 120;
		const left = `${Math.max(8, Math.min(rect.left, view.innerWidth - width - 8))}px`;
		const below = rect.bottom + height + 8 < view.innerHeight;
		const top = `${Math.max(8, below ? rect.bottom + 4 : rect.top - height - 4)}px`;
		return () => Object.assign(host.style, { left, top });
	};
}

const controllers = new WeakMap<Edytor, UrlPasteController>();

/**
 * Register `offer` on `edytor`'s URL paste menu. The first plugin to offer
 * gets the menu's hooks to return (its paste, keys and overlay); the others
 * get none, so one view has one menu whatever the plugins listed.
 */
export const urlPaste = (
	edytor: Edytor,
	offer: UrlPasteOffer
): PluginOperations & PluginDefinitions => {
	const known = controllers.get(edytor);
	if (known) {
		known.offers.push(offer);
		return {};
	}
	const controller = new UrlPasteController(edytor);
	controllers.set(edytor, controller);
	controller.offers.push(offer);
	return controller.hooks();
};
