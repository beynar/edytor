/**
 * Test-side model conveniences (arch-v2 D4, L15). The placement layer keeps
 * one op per intent — `moveBlocks` for every relocation, the facade's
 * `formatRange` for marks — so its single-block move, nest/unnest and mark
 * wrappers left production. Model-level tests and the harness's `model`
 * backend drive the layer through these, with the semantics they had there:
 * `moveBlock` is `moveBlocks([id])`, `nestBlock` appends under a live
 * parent, `unNestBlock` moves beside the parent, `setMark`/`unsetMark`
 * format a live block's display range.
 */
// @ts-nocheck -- drives the vendored engine JS directly (excluded lane).
import { bindModel as bindPlacement } from '../../lib/crdt/index.js';
import { bindText } from '../../lib/crdt/text/model.js';

export const bindModel = (...args: Parameters<typeof bindPlacement>) => {
	const M = bindPlacement(...args);
	const T = bindText(args[0]);
	const moveBlock = (doc, id, dest) => M.moveBlocks(doc, [id], dest);
	const format = (doc, id, offset, length, formats) =>
		doc.transact(() => {
			const v = M.view(doc);
			return (
				M.isLive(doc, id) && T.formatRangeIn(doc, v.blocks, v.own, id, offset, length, formats)
			);
		});
	return {
		...M,
		moveBlock,
		nestBlock: (doc, id, parent) =>
			M.isLive(doc, parent) &&
			moveBlock(doc, id, { parent, index: (M.view(doc).kids.get(parent) ?? []).length }),
		unNestBlock: (doc, id) => {
			const pos = M.positionOf(doc, id);
			const ppos = pos && pos.parent !== null ? M.positionOf(doc, pos.parent) : null;
			return ppos !== null && moveBlock(doc, id, { parent: ppos.parent, index: ppos.index + 1 });
		},
		setMark: (doc, id, offset, length, name, value) =>
			format(doc, id, offset, length, { [name]: value }),
		unsetMark: (doc, id, offset, length, name) => format(doc, id, offset, length, { [name]: null })
	};
};
