/**
 * Test-side model ops (arch-v2 D4, D5 — L15). Production has one prepared op
 * per intent: the document facade prepares every op (validation, ranks,
 * marks, effect) and applies its steps through the placement and text write
 * primitives. The placement layer's own validating op layer — insert, move,
 * delete, split, merge and the content wrappers — left production; model-level
 * tests and the harness's `model` backend drive the bare layer through these,
 * with the semantics they had there (boolean verdicts, no facade policy: no
 * island/void rules, no attribution, no ingress normalization), written over
 * the same primitives. `moveBlock` is `moveBlocks([id])`, `nestBlock` appends
 * under a live parent, `unNestBlock` moves beside the parent,
 * `setMark`/`unsetMark` format a live block's display range.
 */
// @ts-nocheck -- drives the vendored engine JS directly (excluded lane).
import { bindModel as bindPlacement } from '../../lib/crdt/placement/model.js';
import { isLiveIn } from '../../lib/crdt/placement/model.js';
import { bindText } from '../../lib/crdt/text/model.js';
import { randOf } from '../../lib/crdt/rand.js';
import { DEL_PREFIX, TYPE } from '../../lib/crdt/schema.js';
import { patchWrites, readData, writeLeaves } from '../../lib/crdt/data.js';
import { collectBlocks } from './fresh-view.js';

export const bindModel = (...args: Parameters<typeof bindPlacement>) => {
	const M = bindPlacement(...args);
	const T = bindText(args[0]);
	const kids = (doc, parent) => [...(M.view(doc).kids.get(parent) ?? [])];
	const ranks = (doc, sibs, index, count) =>
		M.ranksAt(sibs, Math.max(0, Math.min(index, sibs.length)), count, doc.clientID, randOf(doc));

	const insertBlocks = (doc, dest, specs) => {
		if (specs.length === 0) return true;
		if (dest.parent !== null && !M.isLive(doc, dest.parent)) return false;
		if (M.collides(doc, specs)) return false;
		return doc.transact(() => {
			const r = ranks(doc, kids(doc, dest.parent), dest.index, specs.length);
			specs.forEach((sp, i) => M.materializeSpec(doc, sp, dest.parent, r[i]));
			return true;
		});
	};

	/** The whole-subtree delete: every member is marked (an unmarked one would be promoted, UW-08). */
	const deleteBlock = (doc, id) => {
		const v = M.view(doc);
		if (!isLiveIn(v, id)) return false;
		const members = new Set<string>();
		const walk = (b: string) => {
			members.add(b);
			for (const k of v.kids.get(b) ?? []) walk(k.id);
		};
		walk(id);
		return doc.transact(() => {
			for (const [b, rec] of v.blocks) {
				if (members.has(v.own.ownerOf(b))) rec.node.setAttr(DEL_PREFIX + doc.clientID, true);
			}
			return true;
		});
	};

	const moveBlocks = (doc, ids, dest) => {
		if (ids.length === 0) return false;
		const { placements, own } = M.view(doc);
		if (ids.some((id) => !isLiveIn({ placements, own }, id))) return false;
		if (dest.parent !== null) {
			if (!isLiveIn({ placements, own }, dest.parent)) return false;
			if (ids.some((id) => M.isSelfOrDescendant(placements, own, dest.parent, id))) return false;
		}
		const nodes = ids.map((id) => M.blockNodeOf(doc, id));
		return doc.transact(() => {
			const sibs = kids(doc, dest.parent).filter((k) => !ids.includes(k.id));
			const r = ranks(doc, sibs, dest.index, ids.length);
			nodes.forEach((node, i) => M.writePlacement(doc, node, dest.parent, r[i]));
			return true;
		});
	};

	const splitBlock = (doc, id, offset, newId, tail) => {
		if (M.blockNodeOf(doc, newId) !== null) return false;
		const pos = M.positionOf(doc, id);
		if (!pos) return false;
		const node = M.blockNodeOf(doc, id);
		return doc.transact(() => {
			if (!M.view(doc).blocks.get(id)?.claimsNode) return false;
			if ((M.view(doc).own.display(id) ?? []).length === 0) M.ownText(doc, id);
			const { blocks } = M.view(doc);
			const sibs = kids(doc, pos.parent);
			const myIdx = sibs.findIndex((s) => s.id === id);
			const [rank] = ranks(doc, sibs, myIdx + 1, 1);
			const children = kids(doc, id);
			const t = tail ?? { type: node.getAttr(TYPE), data: readData(node) };
			M.writeSplit(doc, id, offset, newId, t, { p: pos.parent, r: rank });
			const r = ranks(doc, [], 0, children.length);
			children.forEach((k, i) => M.writePlacement(doc, blocks.get(k.id).node, newId, r[i]));
			return true;
		});
	};

	const mergeBlocks = (doc, fromId, intoId) => {
		if (fromId === intoId) return false;
		const v = M.view(doc);
		if (!isLiveIn(v, fromId) || !isLiveIn(v, intoId)) return false;
		const { blocks, placements, own } = v;
		if (M.isSelfOrDescendant(placements, own, intoId, fromId)) return false;
		if (!blocks.get(intoId)?.claimsNode) return false;
		return doc.transact(() => {
			const intoKids = kids(doc, intoId);
			const fromKids = kids(doc, fromId);
			T.claimInto(blocks, own, fromId, intoId);
			const r = ranks(doc, intoKids, intoKids.length, fromKids.length);
			fromKids.forEach((k, i) => M.writePlacement(doc, M.blockNodeOf(doc, k.id), intoId, r[i]));
			return true;
		});
	};

	/** A live content target's view, or null. */
	const ownView = (doc, id) => {
		const v = M.view(doc);
		return isLiveIn(v, id) && v.blocks.get(id)?.claimsNode ? v : null;
	};
	/** `[at, end)` of a display range, clamped. */
	const clamp = (v, id, offset, length) => {
		const total = T.ownedLength(T.flatten(id, v.blocks, v.own));
		const at = Math.max(0, Math.min(offset, total));
		return [at, Math.min(total, at + Math.max(0, length))];
	};
	const insertInto = (doc, id, offset, payload, marks?) =>
		doc.transact(() => {
			let v = ownView(doc, id);
			if (!v) return false;
			if (payload === '') return true;
			// A streamless block gets its own text first (derived writer, R2).
			if ((v.own.display(id) ?? []).length === 0) {
				M.ownText(doc, id);
				v = M.view(doc);
			}
			T.insertIntoText(doc, v.blocks, v.own, id, offset, payload, marks);
			return true;
		});
	const ranged =
		(write) =>
		(doc, id, offset, length, ...rest) =>
			doc.transact(() => {
				const v = ownView(doc, id);
				if (!v) return false;
				const [at, end] = clamp(v, id, offset, length);
				if (end > at) write(doc, v.blocks, v.own, id, at, end - at, ...rest);
				return true;
			});
	const deleteText = ranged(T.deleteRange);
	const format = ranged(T.formatRangeIn);

	const moveBlock = (doc, id, dest) => moveBlocks(doc, [id], dest);
	return {
		...M,
		/** The fresh collect production no longer has (the index is the owner). */
		collectBlocks,
		insertBlocks,
		insertBlock: (doc, dest, spec) => insertBlocks(doc, dest, [spec]),
		deleteBlock,
		moveBlocks,
		splitBlock,
		mergeBlocks,
		insertText: (doc, id, offset, text, marks) => insertInto(doc, id, offset, text, marks),
		insertInline: (doc, id, offset, atom) => insertInto(doc, id, offset, M.buildInline(atom)),
		deleteText,
		removeInline: (doc, id, inlineId) =>
			doc.transact(() => {
				const v = ownView(doc, id);
				const hit = v && T.findAtom(v.own, id, inlineId);
				if (!hit) return false;
				hit.text.delete(hit.at, 1);
				return true;
			}),
		setInlineData: (doc, id, inlineId, data) =>
			doc.transact(() => {
				const v = ownView(doc, id);
				const hit = v && T.findAtom(v.own, id, inlineId);
				if (!hit) return false;
				writeLeaves(hit.node, patchWrites(hit.node, [{ path: [], value: data }]));
				return true;
			}),
		moveBlock,
		nestBlock: (doc, id, parent) =>
			M.isLive(doc, parent) && moveBlock(doc, id, { parent, index: kids(doc, parent).length }),
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
