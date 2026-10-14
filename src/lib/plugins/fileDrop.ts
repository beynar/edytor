/**
 * Files dragged from outside over a view (Notion): the drop indicator a
 * block drag shows, where the files land, and that placement for the drop
 * (the core's `onDrop.ts` asks the view's uploads, `ViewUploads.drop`, and passes it to the occurrence; the view's uploads place one
 * block per file there, one command). The placement is the block drag's
 * own resolution (`DropResolver`) for a drag that moves no block, whose
 * places are the ones the document takes new blocks of the files' kinds
 * at (`canPlaceNew`). Shown only in an editable view whose uploads take
 * one of the files (`viewUploads`); with or without the block handles.
 * Plugin-owned: the view's `FileUploads` (the first media plugin listed with
 * an `upload`) installs it, so a view without one ships none of it.
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import type { DropAt } from '$lib/session/attempt.js';
import { canPlaceNew } from '$lib/session/moves.js';
import { viewUploads } from '$lib/session/uploads.js';
import { DropIndicator } from '$lib/dnd/dropIndicator.js';
import type { DropPlacement } from '$lib/dnd/geometry.js';
import { DropResolver, isDropTarget, type Drag, type Input } from '$lib/dnd/placement.js';

/** The kinds the files of a drag would be, by their types (a `dragover` sees no file, only its type). */
const kindsOf = (edytor: Edytor, dataTransfer: DataTransfer | null) => {
	const uploads = viewUploads(edytor);
	if (!uploads || !dataTransfer) return [];
	const kinds = new Set<string>();
	const add = (file: File) => {
		const kind = uploads.kindOf(file);
		if (kind) kinds.add(kind);
	};
	for (const item of Array.from(dataTransfer.items ?? []))
		if (item.kind === 'file') add(item.getAsFile() ?? new File([], 'file', { type: item.type }));
	// An engine that lists no item for a file (WebKit before the drop): its files themselves.
	if (!kinds.size) Array.from(dataTransfer.files ?? []).forEach(add);
	return [...kinds];
};

class FileDrag {
	readonly indicator: DropIndicator;
	readonly resolver: DropResolver;
	#begun = false;

	constructor(private readonly edytor: Edytor) {
		this.indicator = new DropIndicator(edytor, {
			group: () => [],
			besideOf: (block) => this.resolver.besideOf(block),
			layoutOf: (outer) => this.resolver.layoutOf(outer)
		});
		this.resolver = new DropResolver(edytor, {
			targetOf: (node) => {
				const block = edytor.idToBlock.get(node.dataset.edytorId ?? '');
				return block?.node === node && isDropTarget(edytor, block) ? block : undefined;
			},
			handle: () => null,
			indicator: this.indicator
		});
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
	 * over a drop target, its row's; elsewhere in the host, its margins'.
	 */
	over(kinds: readonly string[], input: Input): DropPlacement | null {
		const document = this.edytor.node?.ownerDocument;
		if (!document) return null;
		if (!this.#begun) {
			this.#begun = true;
			this.indicator.begin(document);
		}
		const drag = this.#drag(kinds);
		const node = this.resolver.hitAt(input);
		const placement = node
			? this.resolver.over(drag, node, input)
			: this.resolver.margin(drag, input);
		if (!placement) {
			this.indicator.clear();
			return null;
		}
		// A margin's placement shows as the block drag's page target does (its reorder holds).
		this.indicator.show(node ?? document.body, placement);
		return placement;
	}

	/** The drag left the view, or dropped: nothing shows. */
	end() {
		this.#begun = false;
		this.indicator.end();
	}
}

const drags = new WeakMap<Edytor, FileDrag>();
const dragOf = (edytor: Edytor) => {
	let drag = drags.get(edytor);
	if (!drag) drags.set(edytor, (drag = new FileDrag(edytor)));
	return drag;
};

/**
 * A `dragover` of files from outside: where they land, shown (Notion's
 * indicator), `null` where none (a read-only view, no uploads taking them,
 * no place the document takes them at).
 */
export const fileDragOver = (edytor: Edytor, event: DragEvent): DropPlacement | null => {
	const kinds = edytor.readonly ? [] : kindsOf(edytor, event.dataTransfer);
	if (!kinds.length) {
		drags.get(edytor)?.end();
		return null;
	}
	return dragOf(edytor).over(kinds, event);
};

/**
 * A drop of files from outside: the placement shown (re-resolved at the
 * drop point), in block terms, and nothing shows any more.
 */
export const fileDropAt = (edytor: Edytor, event: DragEvent): DropAt | null => {
	const placement = fileDragOver(edytor, event);
	fileDragEnd(edytor);
	return placement && { block: placement.target.id, position: placement.position };
};

/** The files' drag left the view (or ended): the indicator goes. */
export const fileDragEnd = (edytor: Edytor) => drags.get(edytor)?.end();
