/**
 * The document's public operations and reads (`DocumentOperations`): the
 * raw path, view-free, with no plugin hook, no view's undo and no readonly
 * check. An `EdytorDocument` carries them itself (`document.insertBlock(…)`),
 * and a room's `transact` callback and `validate` receive them. The
 * facade a document binds has more (the index, the engine hooks): those
 * stay internal. `DOCUMENT_OPERATIONS` lists the names, checked against
 * the interface here and against the facade in `document.ts`. Worker-safe:
 * types and one list.
 */
import type { BlockAttribution } from './attribution/block.js';
import type {
	AnchorAffinity,
	DataTarget,
	DocAnchor,
	DocChange,
	JsonObj,
	OpResult,
	OrderPolicy,
	Prepared
} from './doc/types.js';
import type { DataPatch } from './data.js';
import type { Flow, FlowTarget, FlowView } from './flow.js';
import type { DocBlock } from './nodes.js';
import type {
	BlockId,
	BlockSpec,
	ContentItem,
	Destination,
	InlineSpec,
	ProjectedDoc,
	SplitTail
} from './placement/model.js';
import type { DocPosition, RangeView } from './rangeDelete.js';
import type { ContentRun } from './text/runs.js';
import type { JSONBlock, JSONDoc } from '../utils/json.js';

/** The document's writes: each one transaction, answering what it did (`OpResult`). */
export interface DocumentWrites {
	insertBlock(dest: Destination, spec: JSONBlock | BlockSpec): OpResult;
	insertBlocks(dest: Destination, specs: readonly (JSONBlock | BlockSpec)[]): OpResult;
	moveBlock(id: BlockId, dest: Destination): OpResult;
	moveBlocks(ids: readonly BlockId[], dest: Destination): OpResult;
	nestBlock(id: BlockId, parent: BlockId): OpResult;
	unNestBlock(id: BlockId): OpResult;
	unNestBlocks(ids: readonly BlockId[]): OpResult;
	liftOut(
		id: BlockId,
		kind: string,
		options?: { keep?: boolean; after?: readonly BlockSpec[] }
	): OpResult;
	wrapInLayout(ids: readonly BlockId[], kind?: string, columns?: number): OpResult;
	placeBeside(
		ids: readonly BlockId[],
		target: BlockId,
		side: 'left' | 'right',
		kind?: string
	): OpResult;
	splitBlock(id: BlockId, offset: number, newId: BlockId, tail?: SplitTail): OpResult;
	mergeBlocks(fromId: BlockId, intoId: BlockId): OpResult;
	mergeBackward(id: BlockId): OpResult;
	mergeForward(id: BlockId): OpResult;
	deleteBlock(id: BlockId, options?: { keepChildren?: boolean }): OpResult;
	deleteBlocks(ids: readonly BlockId[]): OpResult;
	setBlock(
		id: BlockId,
		value: {
			type?: string;
			data?: Record<string, unknown>;
			content?: ContentItem[];
			children?: BlockSpec[];
		}
	): OpResult;
	setBlockType(id: BlockId, type: string): OpResult;
	patchData(target: DataTarget, patches: readonly DataPatch[]): OpResult;
	setBlockData(id: BlockId, data: Record<string, unknown>): OpResult;
	duplicateBlock(
		id: BlockId,
		freshId: (oldId: string, kind: 'block' | 'inline') => string
	): OpResult;
	insertTableRow(table: BlockId, index: number): OpResult;
	deleteTableRows(rows: readonly BlockId[]): OpResult;
	insertTableColumn(table: BlockId, index: number, width?: number): OpResult;
	deleteTableColumn(table: BlockId, column: string | number): OpResult;
	moveTableColumn(table: BlockId, column: string | number, to: number): OpResult;
	moveTableRows(rows: readonly BlockId[], to: number): OpResult;
	fillTableCell(row: BlockId, column: string | number): OpResult;
	insertText(id: BlockId, offset: number, text: string, marks?: Record<string, unknown>): OpResult;
	deleteText(id: BlockId, offset: number, length: number): OpResult;
	formatRange(
		id: BlockId,
		offset: number,
		length: number,
		marks: Record<string, unknown>
	): OpResult;
	setMark(id: BlockId, offset: number, length: number, name: string, value: unknown): OpResult;
	unsetMark(id: BlockId, offset: number, length: number, name: string): OpResult;
	clearMarks(id: BlockId, offset: number, length: number): OpResult;
	insertInline(id: BlockId, offset: number, atom: InlineSpec): OpResult;
	removeInline(id: BlockId, inlineId: string): OpResult;
	setInlineData(id: BlockId, inlineId: string, data: Record<string, unknown>): OpResult;
	deleteRange(from: DocPosition, to: DocPosition, view?: RangeView): OpResult;
	replaceRange(from: DocPosition, to: DocPosition, view?: RangeView): OpResult;
	insertFlow(target: FlowTarget, flow: Flow, view?: FlowView): OpResult;
}

/** The document's reads (transaction-aware where the reference says so). */
export interface DocumentReads {
	toJSON(): JSONDoc;
	docData(): JsonObj;
	dataItemIds(target: DataTarget, path: readonly string[]): string[];
	project(): ProjectedDoc;
	blockJSON(id: BlockId): JSONBlock;
	childrenIds(parent: BlockId | null): BlockId[];
	parentOf(id: BlockId): BlockId | null;
	ancestorsOf(id: BlockId): BlockId[];
	positionOf(id: BlockId): Destination | null;
	pathOf(id: BlockId): number[] | null;
	blockTypeOf(id: BlockId): string | undefined;
	blockDataOf(id: BlockId): Record<string, unknown> | undefined;
	blockText(id: BlockId): string | null;
	contentItems(id: BlockId): ContentItem[];
	displayLength(id: BlockId): number;
	runs(id: BlockId): readonly ContentRun[];
	hasBlock(id: BlockId): boolean;
	isVisibleBlock(id: BlockId): boolean;
	listBlockIds(): BlockId[];
	blockAttribution(id: BlockId): BlockAttribution | undefined;
	isVoid(id: BlockId): boolean;
	isIsland(id: BlockId): boolean;
	isLines(id: BlockId): boolean;
	islandOf(id: BlockId): BlockId | null;
	insideIsland(id: BlockId): boolean;
	isLayout(id: BlockId): boolean;
	isLayoutItem(id: BlockId): boolean;
	besideAt(id: BlockId, kind?: string): BlockId;
	isTable(id: BlockId): boolean;
	isTableRow(id: BlockId): boolean;
	isTableCell(id: BlockId): boolean;
	tableOf(id: BlockId): BlockId | null;
	tableColumns(id: BlockId): { id: string; width?: number }[] | null;
	tableGrid(
		id: BlockId
	): { columns: string[]; rows: { id: BlockId; cells: (BlockId | null)[] }[] } | null;
	order(): readonly BlockId[];
	compare(a: BlockId, b: BlockId): number;
	next(id: BlockId, policy?: OrderPolicy): BlockId | null;
	previous(id: BlockId, policy?: OrderPolicy): BlockId | null;
	canPlace(ids: readonly BlockId[], parent?: BlockId | null): boolean;
	canMerge(from: BlockId, into: BlockId): boolean;
	fits(parent: BlockId | null, kind: string): boolean;
	nestParent(ids: readonly BlockId[], parent: BlockId): BlockId;
	landingOf(
		id: BlockId,
		kind: string,
		after?: boolean
	): { parent: BlockId | null; levels: BlockId[] };
	anchorAt(id: BlockId, offset: number, affinity?: AnchorAffinity): DocAnchor | null;
	resolveAnchor(anchor: DocAnchor): { blockId: BlockId; offset: number } | null;
}

/**
 * The document's public operations: the writes, each also prepared
 * (`prepare.<op>(…)`, pure, then `apply(plan)`; `compose` joins plans),
 * the reads, a block's handle, `transact`, `onChange` and `version`. See
 * the document API reference.
 */
export interface DocumentOperations extends DocumentWrites, DocumentReads {
	/** Every write, prepared: a plan of named steps and its effect, or `refused`. Writes nothing. */
	readonly prepare: {
		readonly [K in keyof DocumentWrites]: (...args: Parameters<DocumentWrites[K]>) => Prepared;
	};
	/** Write a prepared plan exactly (a refusal passes through). */
	apply(plan: Prepared): OpResult;
	/** One plan of `parts`, applied in order. */
	compose(...parts: Prepared[]): Prepared;
	/** Group writes in one transaction and one change event (no rollback on a throw). */
	transact<R>(fn: () => R, origin?: unknown): R;
	/** A handle over block `id`: the same operations bound to it (cached; refused when absent). */
	block(id: BlockId): DocBlock;
	/** Hear each transaction's change; answers the unsubscribe. */
	onChange(listener: (change: DocChange) => void): () => void;
	/** Changes on every write that changed the tree. */
	readonly version: number;
}

/** Every name of `DocumentOperations`, for the document's own members (`EdytorDocument`). */
export const DOCUMENT_OPERATIONS = [
	'insertBlock',
	'insertBlocks',
	'moveBlock',
	'moveBlocks',
	'nestBlock',
	'unNestBlock',
	'unNestBlocks',
	'liftOut',
	'wrapInLayout',
	'placeBeside',
	'splitBlock',
	'mergeBlocks',
	'mergeBackward',
	'mergeForward',
	'deleteBlock',
	'deleteBlocks',
	'setBlock',
	'setBlockType',
	'patchData',
	'setBlockData',
	'duplicateBlock',
	'insertTableRow',
	'deleteTableRows',
	'insertTableColumn',
	'deleteTableColumn',
	'moveTableColumn',
	'moveTableRows',
	'fillTableCell',
	'insertText',
	'deleteText',
	'formatRange',
	'setMark',
	'unsetMark',
	'clearMarks',
	'insertInline',
	'removeInline',
	'setInlineData',
	'deleteRange',
	'replaceRange',
	'insertFlow',
	'toJSON',
	'docData',
	'dataItemIds',
	'project',
	'blockJSON',
	'childrenIds',
	'parentOf',
	'ancestorsOf',
	'positionOf',
	'pathOf',
	'blockTypeOf',
	'blockDataOf',
	'blockText',
	'contentItems',
	'displayLength',
	'runs',
	'hasBlock',
	'isVisibleBlock',
	'listBlockIds',
	'blockAttribution',
	'isVoid',
	'isIsland',
	'isLines',
	'islandOf',
	'insideIsland',
	'isLayout',
	'isLayoutItem',
	'besideAt',
	'isTable',
	'isTableRow',
	'isTableCell',
	'tableOf',
	'tableColumns',
	'tableGrid',
	'order',
	'compare',
	'next',
	'previous',
	'canPlace',
	'canMerge',
	'fits',
	'nestParent',
	'landingOf',
	'anchorAt',
	'resolveAnchor',
	'prepare',
	'apply',
	'compose',
	'transact',
	'block',
	'onChange',
	'version'
] as const satisfies readonly (keyof DocumentOperations)[];

/** Every member is listed: a name the list lacks is a compile error here. */
type Unlisted = Exclude<keyof DocumentOperations, (typeof DOCUMENT_OPERATIONS)[number]>;
const everyListed: [Unlisted] extends [never] ? true : Unlisted = true;
void everyListed;
