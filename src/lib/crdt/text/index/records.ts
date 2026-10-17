/**
 * Block records: each registry entry's record (and the losing
 * incarnations a key shows), rebuilt on a structural change, noting what
 * the maintained facts must re-decide.
 */
import { readData } from '../../data.js';
import { Y } from '../../engine.js';
import type { EngineNode } from '../../engine-api.js';
import { baseIdOf, incarnationNode, incarnationsOf, isIncarnationId } from '../../incarnations.js';
import type { BlockId, BlockRec } from '../../placement/model.js';
import { engineOps } from '../../structs.js';
import { CONTENT, NONCE, hasDeleteMark, hasWithdrawMark, isNodeLike } from '../../schema.js';
import type { Claim } from '../model.js';
import type { IndexClaims } from './claims.js';
import type { IndexPlacement } from './placement.js';
import { sameShape, typeAttr } from './shared.js';
import type { IndexState } from './state.js';
import type { IndexStreams } from './streams.js';

/** The block records of one doc's index. */
export const indexRecords = (ix: IndexState & IndexClaims & IndexStreams & IndexPlacement) => {
	const {
		registry,
		blocks,
		shells,
		reclaim,
		rawOrder,
		placementSeeds,
		stateSeeds,
		incarnations,
		noteClaims,
		claimsOf,
		noteKind,
		homeFor
	} = ix;

	// ── records ──────────────────────────────────────────────────────

	/** Fork patch YP14's predicate: the registry values the engine keeps. */
	const kept = engineOps(Y).isKeptReplaced;
	/** The node of `id`: its registry value, or the losing incarnation a derived id names. */
	const nodeAt = (id: BlockId): unknown => {
		const v = registry.getAttr(id);
		if (isNodeLike(v) || !isIncarnationId(id)) return v;
		return incarnationNode(registry, id, kept) ?? undefined;
	};

	const buildRec = (id: BlockId, node: EngineNode): BlockRec => {
		const content = node.getAttr(CONTENT);
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
					stamp: { c: -1, k: -1 - i }
				}));
		return {
			id,
			node,
			type: typeAttr(node),
			data: readData(node),
			n: node.getAttr(NONCE),
			deleted: hasDeleteMark(node) || keyDeleted,
			content: isNodeLike(content) ? content : undefined,
			implicit,
			// Read from its stream once the record is in (`claimsOf`), again after the fold's texts.
			claims: [],
			home: homeFor(id)
		};
	};

	/**
	 * Rebuild (or create, or drop) block `id`'s record, and note what the
	 * maintained facts must re-decide: its owner and the tops of the
	 * blocks it claims, its placement — and, when its entry came or
	 * went, the placements of the blocks whose display edge it holds.
	 */
	const updateBlockRec = (id: BlockId): void => {
		const old = blocks.get(id);
		const node = nodeAt(id);
		if (!isNodeLike(node)) blocks.delete(id);
		else {
			const rec = buildRec(id, node);
			blocks.set(id, rec);
			rec.claims = claimsOf(id);
			reclaim.add(id);
		}
		const rec = blocks.get(id);
		noteShell(id);
		noteClaims(id, old?.claims ?? [], rec?.claims ?? []);
		placementSeeds.add(id);
		if ((old === undefined) !== (rec === undefined)) {
			stateSeeds.add(id);
			for (const c of rawOrder.get(id) ?? []) placementSeeds.add(c.id);
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
		const was = shells.has(id);
		// A losing incarnation is never withdrawn on its own: its key's block decides.
		if (isIncarnationId(id)) shells.delete(id);
		else if (rec !== undefined && !rec.deleted && hasWithdrawMark(rec.node)) shells.add(id);
		else shells.delete(id);
		// A withdrawn cell shows in a column its table no longer lists (`table.cell`): re-place it.
		if (was !== shells.has(id) && rec !== undefined && ix.cellKinds.has(rec.type))
			stateSeeds.add(id);
	};
	const ensureRec = (id: BlockId): void => {
		if (!blocks.has(id)) updateBlockRec(id);
	};
	/**
	 * Re-read the losing incarnations of key `id` after its record
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
