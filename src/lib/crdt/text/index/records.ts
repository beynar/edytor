/**
 * Block records: each registry entry's record (and the losing
 * incarnations a key shows), rebuilt on a structural change, noting what
 * the maintained facts must re-decide.
 */
import { readData } from '../../data.js';
import type { EngineNode } from '../../engine-api.js';
import { baseIdOf, incarnationNode, incarnationsOf, isIncarnationId } from '../../incarnations.js';
import { type BlockId, type BlockRec, candidatesOf } from '../../placement/model.js';
import {
	CLAIMS,
	CONTENT,
	NONCE,
	hasDeleteMark,
	hasWithdrawMark,
	isNodeLike
} from '../../schema.js';
import { type Claim, readClaims } from '../model.js';
import type { IndexAnchored } from './anchored.js';
import type { IndexClaims } from './claims.js';
import type { IndexPlacement } from './placement.js';
import { dropFrom, sameShape, typeAttr } from './shared.js';
import type { IndexState } from './state.js';

export const indexRecords = (ix: IndexState & IndexClaims & IndexAnchored & IndexPlacement) => {
	const {
		Y,
		registry,
		blocks,
		shells,
		attachOf,
		foreignOf,
		retargets,
		reclaim,
		byArgParent,
		placementSeeds,
		stateSeeds,
		incarnations,
		noteClaims,
		effectiveClaims,
		noteKind,
		argParent,
		noteCands
	} = ix;

	// ── records ──────────────────────────────────────────────────────

	/** P14's predicate: the registry values the engine keeps. */
	const kept = (item: unknown): boolean =>
		(Y as unknown as { isKeptReplaced(item: unknown): boolean }).isKeptReplaced(item);
	/** The node of `id`: its registry value, or the losing incarnation a derived id names. */
	const nodeAt = (id: BlockId): unknown => {
		const v = registry.getAttr(id);
		if (isNodeLike(v) || !isIncarnationId(id)) return v;
		return incarnationNode(registry, id, kept) ?? undefined;
	};

	const buildRec = (id: BlockId, node: EngineNode): BlockRec => {
		const list = node.getAttr(CLAIMS);
		const claimsNode = isNodeLike(list) ? list : undefined;
		const content = node.getAttr(CONTENT);
		const own = readClaims(claimsNode);
		const derived = isIncarnationId(id);
		// A losing incarnation lives and dies with its key's block: hidden by its
		// own delete mark or while that block is deleted (a withdrawn one included).
		const keyDeleted = derived ? (blocks.get(baseIdOf(id))?.deleted ?? true) : false;
		// The implicit claims stamp below every written one: an explicit claim
		// (a split moving them to its tail block) outranks them.
		const implicit: Claim[] = derived
			? []
			: incarnationsOf(registry, id, kept).map((x, i) => ({
					m: x.id,
					stamp: { c: -1, k: -1 - i },
					seqIndex: -1
				}));
		const listClaims = implicit.length === 0 ? own : [...implicit, ...own];
		return {
			id,
			node,
			type: typeAttr(node),
			data: readData(node),
			n: node.getAttr(NONCE),
			deleted: hasDeleteMark(node) || keyDeleted,
			content: isNodeLike(content) ? content : undefined,
			claimsNode,
			listClaims,
			// Until the next retarget pass its own claims stay with it (`merge.claim.anchor`).
			claims: effectiveClaims(id, listClaims),
			cands: candidatesOf(node)
		};
	};

	/**
	 * Rebuild (or create, or drop) block `id`'s record, and note what the
	 * maintained facts must re-decide: its owner and the tops of the
	 * blocks it claims (P3), its placement — and, when its entry came or
	 * went, the placements of the blocks whose candidate names it.
	 */
	const updateBlockRec = (id: BlockId): void => {
		const old = blocks.get(id);
		const node = nodeAt(id);
		// Its list may change: its claims stay its own until the retarget pass.
		for (const t of attachOf.get(id) ?? []) {
			if (t === id) continue;
			dropFrom(foreignOf, t, id);
			reclaim.add(t);
		}
		attachOf.delete(id);
		retargets.add(id);
		if (!isNodeLike(node)) blocks.delete(id);
		else blocks.set(id, buildRec(id, node));
		const rec = blocks.get(id);
		noteShell(id);
		noteClaims(id, old?.claims ?? [], rec?.claims ?? []);
		noteCands(id, argParent(old));
		placementSeeds.add(id);
		if ((old === undefined) !== (rec === undefined)) {
			stateSeeds.add(id);
			for (const c of byArgParent.get(id) ?? []) placementSeeds.add(c);
		}
		if (old?.type !== rec?.type) {
			noteKind(id);
			if (
				old === undefined ||
				rec === undefined ||
				ix.roles === null ||
				!sameShape(ix.roles, old.type, rec.type)
			)
				stateSeeds.add(id);
		}
	};
	/** A withdrawn block without a delete mark: its `deleted` is settled after each fold. */
	const noteShell = (id: BlockId): void => {
		const rec = blocks.get(id);
		// A losing incarnation is never withdrawn on its own: its key's block decides (H13).
		if (isIncarnationId(id)) return void shells.delete(id);
		if (rec !== undefined && !rec.deleted && hasWithdrawMark(rec.node)) shells.add(id);
		else shells.delete(id);
	};
	const ensureRec = (id: BlockId): void => {
		if (!blocks.has(id)) updateBlockRec(id);
	};
	/**
	 * Re-read the losing incarnations of key `id` (H13) after its record
	 * changed: each one shown now or before gets its record rebuilt (its
	 * liveness is the key's); returns them, for the fold to rescan.
	 */
	const syncIncarnations = (id: BlockId): string[] => {
		if (isIncarnationId(id)) return [];
		const before = incarnations.get(id) ?? [];
		const now = incarnationsOf(registry, id, kept).map((x) => x.id);
		if (now.length === 0) incarnations.delete(id);
		else incarnations.set(id, now);
		const all = [...new Set([...before, ...now])];
		for (const v of all) updateBlockRec(v);
		return all;
	};

	return {
		kept,
		updateBlockRec,
		ensureRec,
		syncIncarnations
	};
};

export type IndexRecords = ReturnType<typeof indexRecords>;
