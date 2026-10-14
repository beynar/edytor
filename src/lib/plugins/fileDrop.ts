/**
 * Files dragged from outside over a view (Notion): the drop indicator a
 * block drag shows, where the files land, and that placement for the drop.
 * The drag is Pragmatic's external adapter's (`dnd/external.ts`), the same
 * pipeline as the block and table drags: the host is its drop target, which
 * takes a drag of files in an editable view. The placement is the block
 * drag's own resolution (`DropResolver`) for a drag that moves no block,
 * whose places are the ones the document takes new blocks of the files'
 * kinds at (`canPlaceNew`). With or without the block handles.
 *
 * The adapter withholds the files until the drop, so while they are dragged
 * their kinds are every kind the view's uploads take (a place shows only
 * where all of them fit); the drop resolves again with the files' own kinds.
 * Its listeners are the window's, capturing, so the drop target's `onDrop`
 * runs before the host's own `drop` listener (`events/onDrop.ts`), which
 * takes the placement (`ViewUploads.drop.take`) and runs the drop's
 * occurrence (the uploads' paste hook places one block per file there, one
 * command). Plugin-owned: the view's `FileUploads` (the first media plugin
 * listed with an `upload`) installs it, so a view without one ships none of it.
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import type { DropAt } from '$lib/session/attempt.js';
import { canPlaceNew } from '$lib/session/moves.js';
import { autoScrollFor } from '$lib/dnd/autoScroll.js';
import { DropIndicator } from '$lib/dnd/dropIndicator.js';
import {
	containsFiles,
	dropTargetForExternal,
	externalScrollers,
	getFiles
} from '$lib/dnd/external.js';
import { DropResolver, isDropTarget, type Drag, type Input } from '$lib/dnd/placement.js';
import { isKindControl } from '$lib/events/nativeInteractiveControl.js';

/** What the drag asks of the view's uploads. */
export type DropUploads = {
	/** The kind that takes `file`, if any. */
	kindOf(file: File): string | undefined;
	/** Every kind that takes files. */
	readonly types: readonly string[];
};

export class FileDrag {
	readonly #indicator: DropIndicator;
	readonly #resolver: DropResolver;
	#scrolling: (() => void) | null = null;
	#dropped: DropAt | null = null;
	#begun = false;

	constructor(
		private readonly edytor: Edytor,
		private readonly uploads: DropUploads
	) {
		this.#indicator = new DropIndicator(edytor, {
			group: () => [],
			besideOf: (block) => this.#resolver.besideOf(block),
			layoutOf: (outer) => this.#resolver.layoutOf(outer)
		});
		this.#resolver = new DropResolver(edytor, {
			targetOf: (node) => {
				const block = edytor.idToBlock.get(node.dataset.edytorId ?? '');
				return block?.node === node && isDropTarget(edytor, block) ? block : undefined;
			},
			handle: () => null,
			indicator: this.#indicator
		});
	}

	/** The host takes drags of files from outside while it is editable; the answer releases it. */
	attach(host: HTMLElement) {
		const release = dropTargetForExternal({
			element: host,
			canDrop: ({ source }) =>
				!this.edytor.readonly && containsFiles({ source }) && this.uploads.types.length > 0,
			onDragEnter: ({ location }) => {
				this.#dropped = null;
				this.#scrolling ??= autoScrollFor(
					host,
					externalScrollers(() => !this.edytor.readonly)
				);
				this.#over(this.uploads.types, location.current.input);
			},
			onDrag: ({ location }) => this.#over(this.uploads.types, location.current.input),
			onDragLeave: () => this.#end(),
			onDrop: ({ source, location }) => {
				const kinds = new Set(
					getFiles({ source }).flatMap((file) => this.uploads.kindOf(file) ?? [])
				);
				const placement = kinds.size ? this.#over([...kinds], location.current.input) : null;
				this.#end();
				this.#dropped = placement && { block: placement.target.id, position: placement.position };
			}
		});
		return () => {
			release();
			this.#end();
		};
	}

	/** The placement the last drop of files landed at, once (the host's `drop` takes it). */
	take(): DropAt | null {
		const dropped = this.#dropped;
		this.#dropped = null;
		return dropped;
	}

	/** The drag of files of `kinds`: no block moves; a place takes them all. */
	#drag(kinds: readonly string[]): Drag {
		return {
			group: [],
			fits: ({ target, position }) => canPlaceNew(this.edytor, kinds, target, position)
		};
	}

	/**
	 * The placement at the pointer, shown (`null`: none, and nothing shows):
	 * over a drop target, its row's; elsewhere in the host, its margins'; on
	 * a kind's own control, none.
	 */
	#over(kinds: readonly string[], input: Input) {
		const host = this.edytor.node;
		const document = host?.ownerDocument;
		if (!document) return null;
		if (!this.#begun) {
			this.#begun = true;
			this.#indicator.begin(document);
		}
		const at = document.elementsFromPoint?.(input.clientX, input.clientY)[0] ?? null;
		const control = at !== null && isKindControl(host, at);
		const drag = this.#drag(kinds);
		const node = control ? null : this.#resolver.hitAt(input);
		const placement = control
			? null
			: node
				? this.#resolver.over(drag, node, input)
				: this.#resolver.margin(drag, input);
		if (!placement) {
			this.#indicator.clear();
			return null;
		}
		// A margin's placement shows as the block drag's page target does (its reorder holds).
		this.#indicator.show(node ?? document.body, placement);
		return placement;
	}

	/** The drag left the view, or dropped: nothing shows, nothing scrolls. */
	#end() {
		this.#scrolling?.();
		this.#scrolling = null;
		this.#begun = false;
		this.#indicator.end();
	}
}
