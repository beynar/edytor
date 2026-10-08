/**
 * The index's state: every fact the parts of the index share, kept in one
 * object each part reads (`ix`). Containers are created once and mutated in
 * place; the fields a part reassigns (`delim`, `roles`, the children
 * indexes, the counters and flags) are read through `ix` at every use.
 * What one part alone keeps stays in that part.
 */
import type { EngineApi, EngineDoc, EngineTransaction } from '../../engine-api.js';
import {
	REGISTRY_KEY,
	type BlockId,
	type BlockRec,
	type ChildSlot,
	type ResolvedPlacement
} from '../../placement/model.js';
import { DOC_DATA_ROOT } from '../../schema.js';
import type { IdSetLike } from '../../structs.js';
import type { TextEngine } from '../model.js';
import type { LiveRow, RowItem } from '../rows.js';
import type { ContentRun, DisplayRoles, Folded } from '../runs.js';
import type { Cached } from './shared.js';

// ── the edits of one fold (L7 narrowing, P1) ──────────────────
//
// A keystroke inserts or deletes countable items in one backing text.
// The fold records each edited item (the part the fold's id sets
// cover) per text; `foldTexts` places it in its row's gap by walking to
// the nearest boundary, so the row moves by the edit's units and only
// the display owner of that gap's stream recomputes. A boundary item
// written or removed makes the row rescan; a format marker (its effect
// runs to the next same-key marker) or an unresolvable id makes the
// text opaque: every consumer recomputes.
export type TextEdit = { item: RowItem; len: number; del: boolean };
export type TextEdits = { edits: TextEdit[]; scan: boolean; opaque: boolean };

/** One fold's effects: invalidated blocks, rescanned texts, rebuilt facets. */
export type FoldCtx = {
	invalidated: Set<BlockId>;
	/** Per home block: its text's edits, whether it rescans, whether every reader re-reads. */
	texts: Map<BlockId, { edits: TextEdit[]; scan: boolean; opaque: boolean; seen: Set<TextEdits> }>;
	/** The blocks whose entry or nonce changed: their delimiters are re-decided. */
	named: Set<BlockId>;
	table: boolean;
	/** The winning parents, before and after, of the blocks the fold touched. */
	parents: Set<BlockId>;
};

/** A slot in a children index: its display parent, rank and the island it displays out of. */
export type Slot = { parent: BlockId | null; rank: string; reset?: BlockId };

/** Each row's segments at its last placement: segment 0's block, then each cut's key and block. */
export type Placed = { head: BlockId | null; keys: string[]; blocks: BlockId[] };

/** The tree the change report last published. */
export type Published = {
	nodes: Map<
		BlockId,
		{
			parent: BlockId | null;
			index: number;
			type: string;
			data: unknown;
			runs: readonly ContentRun[];
			key?: string;
		}
	>;
	order: Map<BlockId | null, readonly BlockId[]>;
	/** The children index version it was taken at. */
	kids: number;
};

/** A transaction as the fold reads it. */
export type Tx = {
	insertSet?: IdSetLike;
	deleteSet?: IdSetLike;
	changed?: EngineTransaction['changed'];
};

/** The index's self-checks (`indexChecks`), run after each fold and each report. */
export type SelfChecks = { check: () => void; checkPublished: (pub: Published) => void };

/** Build the empty state of `doc`'s index. */
export const indexState = (Y: EngineApi, T: TextEngine, doc: EngineDoc) => {
	// The children index starts as the one without the layout rules (no layout yet).
	const kids0 = new Map<BlockId | null, ChildSlot[]>();
	const slots0 = new Map<BlockId, Slot>();
	return {
		Y,
		T,
		doc,
		registry: doc.get(REGISTRY_KEY),
		/** The document's own data (`crdt/data.ts`): outside the registry, reported apart. */
		dataRoot: doc.get(DOC_DATA_ROOT),

		// ── the replicated-state index
		blocks: new Map<BlockId, BlockRec>(),
		/** Withdrawn blocks without a delete mark (`hist.undo.withdraw`), see the fold's `settle`. */
		shells: new Set<BlockId>(),
		/** Forward dependencies of cached runs: backing text (by home) / walked block → consumers. */
		textConsumers: new Map<BlockId, Set<BlockId>>(),
		listConsumers: new Map<BlockId, Set<BlockId>>(),

		// ── the claim graph (`claims.ts`)
		/** Owner → the blocks it displays (itself included while it owns itself). */
		displaysMap: new Map<BlockId, Set<BlockId>>(),
		/** Blocks whose claims, delete mark or record changed since the last owner pass. */
		ownerSeeds: new Set<BlockId>(),
		/** Blocks whose owner changed since the last placement pass. */
		ownerChanged: new Set<BlockId>(),

		// ── the stream table (`streams.ts`)
		rows: new Map<BlockId, LiveRow>(),
		delim: new Map<BlockId, string>(),
		/** Each block's segment: its row and the cut that opens it (`null`: the row's segment 0). */
		streamIx: new Map<BlockId, { home: BlockId; cut: string | null }>(),
		placed: new Map<BlockId, Placed>(),
		/** Each row's text → its home (rows are keyed by home). */
		homeOfText: new WeakMap<object, BlockId>(),

		// ── anchored merge claims (`anchored.ts`)
		/** Each holder's list claims' effective claimers, by list index (absent: all its own). */
		attachOf: new Map<BlockId, BlockId[]>(),
		/** An effective claimer → the holders whose claims moved to it. */
		foreignOf: new Map<BlockId, Set<BlockId>>(),
		/** A row's home → the holders with an anchored claim in its text. */
		anchoredIn: new Map<BlockId, Set<BlockId>>(),
		/** Holders whose targets the next pass re-decides, and blocks whose claims it re-reads. */
		retargets: new Set<BlockId>(),
		/** Holders with an anchored claim and no stream yet: any re-placed row may resolve them. */
		unresolved: new Set<BlockId>(),
		reclaim: new Set<BlockId>(),

		// ── roles
		/** The role table the display reads; `null` → none. */
		roles: null as DisplayRoles | null,
		/** A stored kind changed since the last report: derived kinds may follow it (XW-08). */
		retyped: false,

		// ── placements and the children index (`placement.ts`, `layout.ts`)
		/** The live blocks the layout rules do not display (`layout.*`), per placement build. */
		dissolved: new Set<BlockId>(),
		/** Resolved placements. */
		placementsMap: new Map<BlockId, ResolvedPlacement>(),
		/** D-18: the texts whose pieces' order is re-decided at the next pass (`order.split.text`). */
		regroup: new Set<BlockId>(),
		/** A block's argmax candidate parent → the blocks naming it (its entry decides theirs). */
		byArgParent: new Map<BlockId, Set<BlockId>>(),
		/** The children index without the layout rules (what they read), and with them. */
		kids0,
		slots0,
		kidsMap: kids0,
		/** Each visible block's slot (display parent, rank, the island it displays out of). */
		slots: slots0,
		/**
		 * The blocks whose shown kind follows their slot — displayed out of
		 * an island, then in a lined island or of a line kind — which the
		 * report re-reads after a retype.
		 */
		following: new Set<BlockId>(),
		/** Bumps whenever a child list changes (the report compares it). */
		kidsVersion: 0,
		/** The child lists patched since the last report (`all`: every list was rebuilt). */
		dirtyLists: new Set<BlockId | null>(),
		/** The blocks that left every list since the last report. */
		leftLists: new Set<BlockId>(),
		allListsDirty: true,
		/** The next pass rebuilds everything (first build, roles, an irregular state). */
		placementFull: true,
		/** Blocks whose candidates or record changed, whose display state changed. */
		placementSeeds: new Set<BlockId>(),
		stateSeeds: new Set<BlockId>(),
		/** Per block: whether its kind is a layout, an item, a lines island (with its line kind). */
		kindsOf: new Map<BlockId, { layout: boolean; item: boolean; line?: string }>(),
		/** The item kinds the roles declare, and those the document holds. */
		itemKinds: new Set<string>(),

		// ── records (`records.ts`)
		/**
		 * The losing incarnations each key shows (H13, `id.same.concurrent`):
		 * blocks of their own under derived ids, claimed by the key's block
		 * before its own claims (`incarnations.ts`).
		 */
		incarnations: new Map<BlockId, string[]>(),

		// ── the run cache (`cache.ts`)
		cache: new Map<BlockId, Cached>(),
		dirty: new Set<BlockId>(),
		/** The index version (`RunView.version`). */
		version: 0,
		/** The fold counters `debug` exposes read-only. */
		foldStats: { folds: 0, pairs: 0, structs: 0 },

		// ── the fold (`fold.ts`) and the report (`report.ts`)
		/** Frames tracking the folds (the write funnel's `track()`), and the report's candidates. */
		frames: new Set<Folded>(),
		candidates: new Set<BlockId>(),
		reporting: false,
		/** The self-checks, once built (`checks.ts`). */
		checks: null as SelfChecks | null
	};
};

export type IndexState = ReturnType<typeof indexState>;
