/**
 * EdytorDoc — the assembled document model.
 *
 * This module binds the three proven engine layers over ONE Y.Doc into the
 * single public surface the command layer and providers consume:
 *
 * - `placement/model.ts` — stable block registry + placement
 *   candidates; identity-preserving move/nest/split/merge.
 * - `text/model.ts` — stable backing texts delimited by stream
 *   boundaries + merge claims; split/merge never copy text.
 * - `text/runs.ts` (`indexOf`) — the maintained run view: immutable run
 *   snapshots, structural sharing, the change report.
 *
 * This module is the wiring: `docFacade` builds a facade's parts, each a
 * module under `doc/` taking an explicit context — the parts before it —
 * and assembles the facade object. An editor's documents use it directly;
 * the public binding (`bindDocModel`, `bindEdytorDoc`) adds the engine
 * layers as objects (`model`, `text`, `runs`) and the room's tasks, so an
 * editor's graph holds none of what only they reach.
 *
 * - `doc/gate.ts` — the schema manifest and gate (module-level);
 *   `doc/seed.ts` — the version record and the deterministic seed;
 *   `doc/types.ts` — the public types; `doc/plan.ts` — op results, a plan's
 *   effect, ingress normalization.
 * - `doc/reads.ts` (`DocBase`: the doc, its engine, its index and
 *   roles) — the reads, roles and document order.
 * - `doc/funnel.ts` — the write funnel (`write`, `apply`, attribution);
 *   `doc/events.ts` — `onChange`; `doc/history.ts` —
 *   `createUndoManager`; `doc/anchors.ts` — caret anchors.
 * - `doc/ops.ts` — one closure over the reads: the structural capability
 *   (`canPlace`, `fits`, `canMerge`, the island and void rules), the step
 *   writers every op composes (ranks, settle, emptying, dissolving) and the
 *   prepared op families (placement, layout, split and merge, delete, type
 *   and data, text, atoms and marks); range deletion and flow placement are
 *   `rangeDelete.ts` and `flow.ts`, over them (`OpsContext`).
 *
 * ── Identity discipline ────────────────────────────────────────────────
 *
 * Relocation (move/nest/unnest/split/merge/delete-with-children) preserves
 * block AND atom identity. New identity is created
 * ONLY by ops whose purpose is fresh identity: `insertBlock`
 * (caller-assigned ids; nested spec children included), `duplicateBlock`
 * (explicit fresh ids for paste/drag-clone), and `setBlock` content/children
 * replacement (baseline `setBlock` semantics — replacement is a new-identity
 * operation).
 */
import { setMarkEdges } from './text/marks.js';
import type { EngineApi, EngineDoc, YDoc } from './engine-api.js';
import { keepingReplaced } from './incarnations.js';
import { clientsOf } from './structs.js';
import { SCHEMA } from './schema.js';
import {
	bindModel,
	blockText,
	crdtId,
	listBlockIds,
	project,
	resolveBlock,
	type BlockId
} from './placement/model.js';
import { bindText } from './text/model.js';
import { bindPurge, readHorizon } from './purge.js';
import { restoreDocument } from './restore.js';
import {
	bindRuns,
	indexOf,
	type DeclaredKinds,
	type DisplayRoles,
	type KindRole,
	type RunView
} from './text/runs.js';
import {
	bindBlockAttribution,
	blockAttributionOf,
	type BlockAttribution
} from './attribution/block.js';
import { rangeDeleteOps } from './rangeDelete.js';
import { flowOps } from './flow.js';
import type { JSONBlock, JSONDoc } from '../utils/json.js';
import {
	assertSchema,
	checkSchema,
	isInitialized,
	META_KEY,
	registryEmpty,
	SCHEMA_NAME,
	SCHEMA_VERSION,
	SchemaMismatchError,
	schemaVersion
} from './doc/gate.js';
import { bindSeed, restore } from './doc/seed.js';
import { applied, ref } from './doc/plan.js';
import { docReads, type DocBase } from './doc/reads.js';
import { writeFunnel } from './doc/funnel.js';
import { docEvents } from './doc/events.js';
import { docHistory } from './doc/history.js';
import { docAnchors } from './doc/anchors.js';
import { docOps } from './doc/ops.js';
import type { SuggestContext } from './doc/suggest.js';
// Types the facade's inferred declaration names: imported here so the
// emitted `bindEdytorDoc` type names them rather than an import path
// (`api/` reports the difference), so no value of the module reads them.
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { EngineNode } from './engine-api.js';
import type { ContentItem, InlineSpec, ModelView, SplitTail } from './placement/model.js';
import type { Anchor } from './text/model.js';
import type { ContentRun } from './text/runs.js';
import type { DocPosition } from './rangeDelete.js';
import type { DataPatch } from './data.js';
import type { DocumentOperations } from './operations.js';
/* eslint-enable @typescript-eslint/no-unused-vars */
import type {
	AnchorAffinity,
	BlockRole,
	DataTarget,
	DocAnchor,
	DocChange,
	EdytorDocConfig,
	JsonObj,
	OpResult,
	OrderPolicy,
	Plan,
	PlanEffect,
	PlanStep,
	Prepared,
	TextRange
} from './doc/types.js';

// ── schema manifest and gate (`doc/gate.ts`) ────────────────────────────

export { SCHEMA };
export {
	assertSchema,
	checkSchema,
	isInitialized,
	META_KEY,
	registryEmpty,
	SCHEMA_NAME,
	SCHEMA_VERSION,
	SchemaMismatchError,
	schemaVersion
};
export type { SchemaProblem } from './doc/gate.js';
export { SEED_ORIGIN } from './doc/seed.js';
export { DocumentDestroyedError } from './doc/funnel.js';
export { DEFAULT_HISTORY_LIMIT } from './doc/history.js';
export type {
	AnchorAffinity,
	BlockRole,
	DataTarget,
	DocAnchor,
	DocChange,
	EdytorDocConfig,
	OpResult,
	OrderPolicy,
	Plan,
	PlanEffect,
	PlanStep,
	Prepared,
	TextRange
};

export type EdytorDoc = ReturnType<EdytorDocBinding['create']>;
/** A facade as the editor reads it: every member but the public binding's engine layers. */
export type DocFacade = Omit<EdytorDoc, 'model' | 'text'>;
export type EdytorDocBinding = ReturnType<typeof bindEdytorDoc>;
export type DocModelBinding = ReturnType<typeof bindDocModel>;

/**
 * The engine layers a facade lists as `model` and `text`: the public
 * binding's ({@link bindDocModel}); an editor's facade lists none, so its
 * graph holds neither object.
 */
type Layers = {
	model: ReturnType<typeof bindModel> | undefined;
	text: ReturnType<typeof bindText> | undefined;
};

/**
 * The per-doc facade factory over the engine `Y` (the editor's documents
 * use it directly; {@link bindDocModel} is the public binding around it).
 */
/**
 * Give `doc` edytor's rule — a registry value a concurrent creation replaced
 * keeps its subtree (fork patch YP14, `keepingReplaced`) — or refuse it
 * loudly when it has integrated updates without it: the engine decides what
 * a replaced value keeps when it integrates, so a document that took updates
 * under the engine's default could lose a subtree its peers keep, forever.
 * Create it with `createDoc()` (or `createDocument`/`loadDocument`), never
 * `new Y.Doc()`.
 */
export const adoptRules = <D extends object>(doc: D): D => {
	const d = doc as { keepReplaced?: unknown };
	if (d.keepReplaced == null && clientsOf(doc as never).size > 0)
		throw new TypeError(
			"edytor: this document took updates before it carried edytor's rules (create it with createDoc(), createDocument or loadDocument, not new Y.Doc())"
		);
	return keepingReplaced(d) as D;
};

export const docFacade = <L extends Layers>(Y: EngineApi, layers: L) => {
	// Compact per-block attribution writes (`attribution/block.ts`).
	// One bound instance per engine binding; its suppression memory is
	// per-doc (WeakMap-keyed), so facades on the same doc share it.
	const BA = bindBlockAttribution(Y);
	const { init, seed } = bindSeed(Y, BA);

	const create = (doc: EngineDoc, config: EdytorDocConfig = {}) => {
		adoptRules(doc);
		setMarkEdges(doc, config.markEdge ?? (() => undefined));
		const roleOf = config.roleOf ?? (() => undefined);
		const defaultType = config.defaultType ?? 'paragraph';
		const defaultChildOf = config.defaultChildOf ?? (() => undefined);
		const rendersContentOf = config.rendersContent ?? (() => true);
		const runsView: RunView = indexOf(doc);
		// The role table — the display and every guard below ask it.
		// a void kind displays no children — the index sheds them into its
		// slot at read time, so a child a peer nests or splits under a block
		// another peer retypes to a void shows on every replica. A block
		// promoted out of an island displays as its display parent's default
		// child, as a delete of the island retypes the ones it saw. An island
		// declared `lines` holds only lines of its `defaultChild` kind.
		// A layout displays only its items — its
		// `defaultChild` kind — and only two or more (`layout.*`). A table
		// displays only its rows and a row only its cells (`table.*`).
		let kinds = new Map<string | null, KindRole>();
		let declared: DeclaredKinds | undefined;
		const roles: DisplayRoles = {
			of: (type) => {
				let k = kinds.get(type);
				if (k === undefined) {
					const role = type === null ? undefined : roleOf(type);
					const own = type === null ? undefined : defaultChildOf(type);
					const renders = type === null || rendersContentOf(type);
					kinds.set(
						type,
						(k = {
							childless: role?.void === true,
							island: role?.island === true,
							container: !renders && role?.void !== true && role?.island !== true,
							rendersContent: renders,
							child: own ?? defaultType,
							line: role?.island === true && role.lines === true ? own : undefined,
							layout: role?.layout === true ? own : undefined,
							table: role?.table === true ? own : undefined
						})
					);
				}
				return k;
			},
			declared: () => {
				if (declared === undefined) {
					const all = [...(config.kinds?.() ?? [])].map(roles.of);
					const rows = new Map(
						all.flatMap((k) => (k.table ? [[k.table, roles.of(k.table).child]] : []))
					);
					declared = {
						lines: new Set(all.flatMap((k) => k.line ?? [])),
						layouts: [...(config.kinds?.() ?? [])].filter((t) => roles.of(t).layout !== undefined),
						items: new Set(all.flatMap((k) => k.layout ?? [])),
						rows,
						cells: new Set(rows.values())
					};
				}
				return declared;
			}
		};
		if (config.roleOf) runsView.roles(roles);

		// The facade's parts, each over the ones before it (`doc/*`).
		const base: DocBase = { Y, doc, runsView, roles, roleOf, rendersContentOf };
		const reads = { ...base, ...docReads(base) };
		// The capability, the step writers and the prepared op families (`doc/ops.ts`).
		const ops = { ...reads, ...docOps(reads) };
		const {
			blockJSON,
			view,
			blockTypeOf,
			blockDataOf,
			docData,
			dataItemIds,
			dataPreview,
			childrenIds,
			positionOf,
			pathOf,
			ancestorsOf,
			slotOf,
			isVoid,
			isIsland,
			isLines,
			islandOf,
			insideIsland,
			isLayout,
			isLayoutItem,
			order,
			compare,
			next,
			previous,
			displayLength,
			contentItems,
			hasBlock,
			live
		} = reads;
		const { canPlace, fits, nestParent, canMerge, defaultChild, plan, landingOf, besideAt } = ops;

		const funnel = writeFunnel({ ...reads, BA, config });
		const { write, apply } = funnel;
		const events = docEvents({ runsView });
		const { onChange } = events;
		const dispose = (): void => {
			funnel.dispose();
			events.close();
		};
		const { createUndoManager } = docHistory({ ...base, ...funnel, init });
		const { anchorAt, followUndo, resolveAnchor } = docAnchors(reads);

		/** Every document op, prepared — `apply(prepare.op(…))` is the op. */
		const prepare = {
			...ops.prepare,
			/**
			 * Move `id` to the last position under `parent` — under a container
			 * it is no item of, under its last item (`nestParent`: Tab after a list).
			 */
			nestBlock: (id: BlockId, parent: BlockId) => {
				const at = nestParent([ref(id)], ref(parent));
				return ops.prepare.moveBlocks([id], { parent: at, index: childrenIds(at).length });
			},
			/** Delete a block selection — one plan; only the members leave (`deleteBlocks` above). */
			deleteBlocks: (ids: readonly BlockId[]): Prepared => ops.prepare.deleteBlocks(ids),
			...rangeDeleteOps(ops),
			...flowOps(ops)
		};

		/**
		 * What a part built over this document reads beyond the facade (the
		 * shared suggestions, `doc/suggest.ts`): the reads, a facade over
		 * another doc (`create`, with this `config`);
		 * `v` counts its changes no index fact shows (in `version`), and
		 * `base`, when set, is the export `toJSON()` gives unless asked for
		 * the suggestions.
		 */
		const part: SuggestContext = {
			...reads,
			config,
			create: create as SuggestContext['create'],
			v: 0,
			base: undefined
		};

		/**
		 * Plans prepared at one version, as one plan (refused if any part is;
		 * stamped with the oldest part's version, so `apply` refuses a stale
		 * one). The caller guarantees the parts are independent: no step's
		 * coordinates depend on an earlier part's writes.
		 */
		const compose = (...parts: Prepared[]): Prepared => {
			const plans = parts as Plan[];
			const version = Math.min(...plans.map((p) => p.version));
			return (
				parts.find((p) => !('writes' in p)) ?? {
					...plan(
						plans.flatMap((p) => p.ids),
						plans.flatMap((p) => p.writes)
					),
					version
				}
			);
		};

		// ── JSON boundary ─────────────────────────────────────────────────

		/**
		 * Public JSON export — `{ children: JSONBlock[] }` matching
		 * `src/lib/utils/json.ts` (`data` always present, `content`/`children`
		 * omitted when empty): the one serializer, {@link blockJSON}, over the
		 * root's visible children.
		 */
		const toJSON = (options?: { suggestions?: boolean }): JSONDoc => {
			// A part's export first (the shared suggestions': without the pending ones, `sugg.json.base`).
			const base = !options?.suggestions && part.base?.();
			if (base) return base;
			const data = docData();
			const children = childrenIds(null).map(blockJSON);
			return Object.keys(data).length > 0
				? { data: data as JSONDoc['data'], children }
				: { children };
		};

		// ── facade object ─────────────────────────────────────────────────

		/** A read taking an id first: the id normalizes at ingress. */
		const byRef =
			<I extends BlockId | null, A extends unknown[], R>(f: (id: I, ...rest: A) => R) =>
			(id: I, ...rest: A): R =>
				f(ref(id), ...rest);

		/**
		 * The public operations (`DocumentOperations`), each name once: what
		 * an `EdytorDocument` forwards. The facade has them and the internal
		 * members below.
		 */
		const api = {
			// reads — every id argument normalizes at ingress
			project: () => project(doc),
			toJSON,
			blockJSON: byRef(blockJSON),
			childrenIds: byRef(childrenIds),
			positionOf: byRef(positionOf),
			pathOf: byRef(pathOf),
			parentOf: byRef((id: BlockId) => positionOf(id)?.parent ?? null),
			ancestorsOf: byRef((id: BlockId) => ancestorsOf(id)),
			listBlockIds: () => listBlockIds(doc),
			blockText: byRef((id: BlockId) => blockText(doc, id)),
			blockTypeOf: byRef(blockTypeOf),
			blockDataOf: byRef(blockDataOf),
			docData,
			dataItemIds,
			dataPreview,
			/**
			 * Compact per-block attribution (`{createdBy, contributors,
			 * lastChangedBy}`), or `undefined` for unauthored/system blocks.
			 * O(1) per call; live-replicated (remote values read the same).
			 */
			blockAttribution: byRef((id: BlockId): BlockAttribution | undefined =>
				blockAttributionOf(doc, id)
			),
			displayLength: byRef(displayLength),
			contentItems: byRef(contentItems),
			hasBlock: byRef(hasBlock),
			isVisibleBlock: byRef(live),
			order,
			compare: (a: BlockId, b: BlockId) => compare(ref(a), ref(b)),
			next: byRef(next),
			previous: byRef(previous),
			// caret anchors — backing-text-bound selection endpoints
			anchorAt: byRef(anchorAt),
			resolveAnchor,
			isVoid: byRef(isVoid),
			isIsland: byRef(isIsland),
			isLines: byRef(isLines),
			/** `id` is a layout: its kind's role says `layout` (`layout.*`). */
			isLayout: byRef(isLayout),
			/** `id` is a layout item: of its layout's item kind, directly in it (a column). */
			isLayoutItem: byRef(isLayoutItem),
			/** The block a beside placement at `id` stands beside (`placeBeside`'s resolution). */
			besideAt: (id: BlockId, kind?: string) => besideAt(id, kind),
			islandOf: byRef((id: BlockId) => islandOf(id)),
			/** `id` is a table: its kind's role says `table` (`table.*`). */
			isTable: byRef(reads.isTable),
			/** `id` is a table's row: of its table's row kind, directly in it. */
			isTableRow: byRef(reads.isTableRow),
			/** `id` is a table's cell: of its row's cell kind, directly in a row of a table. */
			isTableCell: byRef(reads.isTableCell),
			/** The table `id` is, or whose row or cell it is; `null` for any other block. */
			tableOf: byRef(reads.tableOf),
			/** The columns a table lists (`data.columns`), or `null` when it lists none. */
			tableColumns: byRef(reads.tableColumns),
			/**
			 * A table as a grid: its column ids and each shown row's cells by
			 * column, `null` where the row shows none (a padded cell, `table.pad`).
			 */
			tableGrid: byRef(reads.tableGrid),
			insideIsland: byRef((id: BlockId) => insideIsland(id)),
			// structural capability
			canPlace: (ids: readonly BlockId[], parent?: BlockId | null) =>
				canPlace(ids.map(ref), parent == null ? parent : ref(parent)),
			canMerge: (from: BlockId, into: BlockId) => canMerge(ref(from), ref(into)),
			/** May a block of `kind` sit directly under `parent`? The container rule (`fits`). */
			fits: (parent: BlockId | null, kind: string) =>
				fits(parent == null ? null : ref(parent), ref(kind)),
			/** Where `ids` nest when nested into `parent` (Tab, a drop inside it): `nestParent`. */
			nestParent: (ids: readonly BlockId[], parent: BlockId) =>
				nestParent(ids.map(ref), ref(parent)),
			/** Where a block of `kind` at `id`'s place lands, and the containers it leaves (`liftOut`). */
			landingOf: (id: BlockId, kind: string, after?: boolean) =>
				landingOf(ref(id), ref(kind), after),
			// maintained runs (bound to this doc)
			runs: byRef(runsView.runs),
			// events
			onChange,
			// every op — each returns an {@link OpResult}; `apply(prepare.op(…))`
			...applied(prepare, apply),
			/** Every op prepared: pure, a plan of named steps + its effect, or `refused`. */
			prepare,
			/** Write a prepared plan exactly (refusals pass through). */
			apply,
			compose,
			// transactions (composed ops already run in one; expose for callers
			// that batch several ops into one undo step / one event)
			transact: <R>(fn: () => R, origin?: unknown): R => write(() => doc.transact(fn, origin)),
			// ── model-state version ─────────────────────────────
			/**
			 * The index version — bumps on every fold that changed derived
			 * state, mid-transaction writes included. Read surfaces that
			 * memoize on it (the editor's projected-tree cache) always observe
			 * post-write state — this is the read-your-writes contract.
			 */
			get version() {
				// A part's change may show in no index fact (a suggestion's decision).
				return runsView.version() + part.v;
			}
		} satisfies DocumentOperations;
		const internal = {
			// lifecycle
			init: (opts?: Parameters<typeof init>[1]) => write(() => init(doc, opts)),
			/** Apply the deterministic seed of `value` and the document's `data` — the document's seed decision. */
			seed: (value: JSONBlock[], data?: JsonObj) =>
				write(() => seed(doc, value, defaultType, data)),
			isInitialized: () => isInitialized(doc),
			/** Replicated `meta.v` schema version (the module-level read, bound). */
			schemaVersion: () => schemaVersion(doc),
			/**
			 * The schema gate for this doc — throws {@link SchemaMismatchError}
			 * on unversioned-content or unsupported-version state. Consumers
			 * (`Edytor.sync()`, packed consumers) call it before trusting
			 * a synced doc.
			 */
			checkSchema: () => checkSchema(doc),
			assertSchema: () => assertSchema(doc),
			dispose,
			createUndoManager,
			/** @internal What a part built over the document reads and writes (`doc/suggest.ts`). */
			part,
			/** Visible children of `parent` with their ranks, in `(rank, id)` order. */
			childSlots: (parent: BlockId | null) => view().kids.get(parent) ?? [],
			slotOf: byRef(slotOf),
			crdtId: byRef((id: BlockId) => crdtId(doc, id)),
			resolveBlock: byRef((id: BlockId) => resolveBlock(doc, id)),
			followUndo,
			// roles
			/** Re-read the roles after `roleOf` answers differently (roles adopted later). */
			rolesChanged: (place = true) => {
				kinds = new Map();
				declared = undefined;
				if (place) runsView.roles(roles);
			},
			defaultChild: byRef(defaultChild),
			contentJSON: byRef(runsView.contentJSON),
			// escape hatch for the history and debugging — the bound engine layers.
			model: layers.model as L['model'],
			text: layers.text as L['text'],
			runsView,
			/** The public members' names (`EdytorDocument` forwards them). */
			api: api as object
		};
		// The public members joined as they are (the `version` getter stays one).
		return Object.defineProperties(
			internal,
			Object.getOwnPropertyDescriptors(api)
		) as typeof internal & typeof api;
	};
	return create;
};

/**
 * Bind the assembled model to a concrete engine surface. `Y` must be the
 * vendored v14 module — injected so this file type-checks structurally and
 * never imports vendor `.js` (see `engine-api.ts`). A document composes
 * this binding; {@link bindEdytorDoc} adds the room's purge and restore.
 */
export const bindDocModel = (Y: EngineApi) => {
	const M = bindModel(Y);
	const T = bindText(Y);
	const R = bindRuns(Y);
	const { init, seed } = bindSeed(Y, bindBlockAttribution(Y));
	const create = docFacade(Y, { model: M, text: T });
	return {
		/** The schema manifest constants table. */
		SCHEMA,
		SCHEMA_VERSION,
		SCHEMA_NAME,
		META_KEY,
		/** Doc-level API (no facade needed). */
		init,
		restore,
		seed,
		isInitialized,
		schemaVersion,
		registryEmpty,
		checkSchema,
		assertSchema,
		SchemaMismatchError,
		/** Attach the per-doc facade. */
		create,
		/**
		 * A new engine document that is an edytor document from the start:
		 * a registry value a concurrent creation replaced keeps its subtree
		 * (each edytor document carries the rule; the engine's default stays
		 * upstream's). `create` gives it to a document it adopts, which must
		 * not have integrated anything yet.
		 */
		newDoc: (opts?: ConstructorParameters<EngineApi['Doc']>[0]): YDoc =>
			keepingReplaced(new Y.Doc(opts)),
		/** The bound engine layers (same instances the facades use). */
		model: M,
		text: T,
		runs: R
	};
};

/**
 * {@link bindDocModel} with the room's tasks: only the public binding
 * (`bindCrdt(Y).doc`) reaches them, so an editor's graph holds neither.
 */
export const bindEdytorDoc = (Y: EngineApi) => {
	const { model, text, runs, ...binding } = bindDocModel(Y);
	// The spread last: the declared type lists the binding first, as before.
	return {
		/**
		 * Purge from `doc` what was deleted before `horizon` (`room.purge.what`): real deletes, inside the caller's transaction,
		 * and the horizon record every history reads (`hist.purge.horizon`).
		 * The room's purge task runs it; `facade` is a facade over `doc`.
		 */
		purge: bindPurge(Y).purge,
		/** The purge horizon `doc` holds, or `null`. */
		horizonOf: (doc: EngineDoc) => readHorizon(doc),
		/**
		 * Make the visible document `doc` equal `json`, keeping the ids the
		 * registry holds and writing only what differs (`room.history.restore`), inside the caller's transaction.
		 */
		restoreTo: restoreDocument,
		model,
		text,
		runs,
		...binding
	};
};
