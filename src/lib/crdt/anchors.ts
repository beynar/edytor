/**
 * Anchors (R4, §4.1 `doc/anchors`): the seam of a vanished endpoint.
 *
 * A deleted block keeps its replicated slot — its winning placement `{p, r}`
 * — so the place it vacated is the same answer on every replica, whatever
 * order the deletes arrived in and whatever the view dropped first. The seam
 * climbs while the display parent is dead, then looks among the live
 * parent's visible children, ordered by `(rank, id)`: the start of the first
 * displayable stop at or after the slot, else the end of the last one before
 * it; with neither, the same question one level up (the parent's own content
 * is then the stop before the slot). A stop descends: forward, a block's own
 * content, then its children in order; backward, its own content's end
 * (`sel.seam.next-sibling`: "the previous sibling's end"), else its children
 * last first.
 *
 * `displayable` is the Surface's fact (§2.4: the cell is mounted and not
 * hidden by view state — a collapsed toggle, a snippet that did not render
 * `content()`); the document never reads the view. The seam applies only to
 * endpoints the view did not author: a local command authors its own result
 * selection (R9).
 */
import type { BlockId } from './index.js';

type Slot = { id: BlockId; rank: string };

/** The document reads the seam needs (the facade satisfies it). */
export type SeamDoc = {
	slotOf(id: BlockId): { parent: BlockId | null; rank: string } | null;
	childSlots(parent: BlockId | null): readonly Slot[];
	isVisibleBlock(id: BlockId): boolean;
	displayLength(id: BlockId): number;
};

export type SeamPoint = { block: BlockId; offset: number };

/** The children index order (`childrenIndex`): rank, then id. */
const before = (a: Slot, b: Slot) => (a.rank === b.rank ? a.id < b.id : a.rank < b.rank);

/**
 * Where an endpoint whose block `dead` vanished lands: a displayable stop next
 * to the slot `dead` (or its topmost dead ancestor) occupied. `dead === null`
 * asks for the document's first stop. `null` when nothing is displayable.
 */
export const seam = (
	doc: SeamDoc,
	dead: BlockId | null,
	displayable: (id: BlockId) => boolean
): SeamPoint | null => {
	const first = (id: BlockId): SeamPoint | null =>
		displayable(id) ? { block: id, offset: 0 } : pick(doc.childSlots(id), first);
	const last = (id: BlockId): SeamPoint | null =>
		displayable(id)
			? { block: id, offset: doc.displayLength(id) }
			: pick([...doc.childSlots(id)].reverse(), last);
	const pick = (slots: readonly Slot[], stop: (id: BlockId) => SeamPoint | null) => {
		for (const slot of slots) {
			const found = stop(slot.id);
			if (found) return found;
		}
		return null;
	};
	let slot = dead === null ? null : doc.slotOf(dead);
	let at: Slot & { parent: BlockId | null } = { id: '', rank: '', parent: null };
	if (dead !== null && slot) {
		let id = dead;
		while (slot.parent !== null && !doc.isVisibleBlock(slot.parent)) {
			id = slot.parent;
			const up = doc.slotOf(id);
			if (!up) break;
			slot = up;
		}
		at = { id, ...slot };
	}
	for (;;) {
		const siblings = doc.childSlots(at.parent);
		const found =
			pick(
				siblings.filter((s) => before(at, s)),
				first
			) ?? pick(siblings.filter((s) => !before(at, s)).reverse(), last);
		if (found || at.parent === null) return found;
		const up = doc.slotOf(at.parent);
		at = { id: at.parent, rank: up?.rank ?? '', parent: up?.parent ?? null };
	}
};
