/**
 * Legacy (v13 Edytor) document reader.
 *
 * A v13 Edytor document is a `doc.getMap('content')` root whose attrs are
 * `{id:'root', type:'root', data, children: Y.Array<YMap>, content:
 * Y.Array<YText|YMap>}`; each block Y.Map carries `{type, id, data,
 * children, content}`; content arrays mix `Y.Text` parts (marks = format
 * attributes) and `Y.Map` inline atoms (`{id, type, data}`). A separate
 * `doc.getText('INITIALIZED')` root marks initialization.
 *
 * When those v1 updates are applied to the vendored v14 engine, every legacy
 * shared type decodes as a unified `Y.Node` with `_legacyTypeRef` recording
 * the original class:
 *
 * | v13 type  | `_legacyTypeRef` | read as                          |
 * | --------- | ---------------- | -------------------------------- |
 * | `Y.Array` | 0                | sequence children (`get`/`length`) |
 * | `Y.Map`   | 1                | attrs (`getAttr`/`attrKeys`)     |
 * | `Y.Text`  | 2                | delta children: `{insert, format}` |
 * | fragment  | 4                | root shared types                |
 *
 * Tombstoned content never appears — deleted blocks are absent from the
 * children sequence, deleted/format-removed text is absent from the delta —
 * so the materialized JSON is the logical doc exactly as a v13 reader saw
 * it (the same contract the U00 fixtures pin).
 */
import type { EngineApi, EngineDoc, EngineNode } from '../engine-api.js';
import {
	cloneJson,
	type JSONBlock,
	type JSONDoc,
	type JSONInlineBlock,
	type JSONText,
	type SerializableContent
} from '../../utils/json.js';

// Legacy type refs (vendored `structs/Item.js` — not re-exported publicly).
const Y_ARRAY_REF = 0;
const Y_MAP_REF = 1;
const Y_TEXT_REF = 2;

/** v13 root key for the document tree. */
export const LEGACY_ROOT_KEY = 'content';
/** v13 init marker root (`doc.getText('INITIALIZED')`). */
export const LEGACY_INITIALIZED_KEY = 'INITIALIZED';

/**
 * Raised when legacy update rows carry structs whose CRDT dependencies are
 * absent from the stored set — i.e. a peer's update never reached this
 * browser's IndexedDB before cutover. Applying such rows leaves
 * `store.pendingStructs`/`pendingDs` non-null and the materialized JSON
 * would silently omit the un-integrated content, so the reader fails closed
 * instead of producing a truncated document (gate-2 migration probe).
 */
export class PendingLegacyUpdatesError extends Error {
	/** Clients whose structs are still missing (`client → clock` needed). */
	readonly missing: ReadonlyMap<number, number>;
	constructor(missing: ReadonlyMap<number, number>, hasPendingDs: boolean) {
		const clients = [...missing.keys()].join(', ');
		super(
			`Legacy update rows have unmet CRDT dependencies (pending structs` +
				`${clients.length > 0 ? ` waiting on client(s) ${clients}` : ''}` +
				`${hasPendingDs ? ', pending delete set' : ''}). ` +
				`Materializing now would silently drop content that has not integrated.`
		);
		this.name = 'PendingLegacyUpdatesError';
		this.missing = missing;
	}
}

type LegacyNode = EngineNode & { _legacyTypeRef?: number };

type DeltaInsertOp = {
	type?: string;
	insert?: unknown;
	format?: Record<string, unknown>;
};

/**
 * True iff the doc carries the v13 Edytor schema: a `content` root whose
 * `children` attr is a sequence node. Anything else (empty doc, v14 schema,
 * foreign document) is rejected by the migration path — it is not a legacy
 * document we know how to read.
 */
export const isLegacyDoc = (doc: EngineDoc): boolean => {
	const root = doc.get(LEGACY_ROOT_KEY) as LegacyNode;
	const children = root.getAttr('children') as LegacyNode | undefined;
	return children != null && children._legacyTypeRef === Y_ARRAY_REF;
};

const readText = (node: LegacyNode): JSONText[] => {
	const out: JSONText[] = [];
	const children = (node.delta?.toJSON?.() as { children?: DeltaInsertOp[] } | undefined)?.children;
	for (const op of children ?? []) {
		if (typeof op?.insert !== 'string') continue;
		if (op.insert.length === 0) continue;
		const t: JSONText = { text: op.insert };
		if (op.format && Object.keys(op.format).length > 0) {
			t.marks = { ...(op.format as Record<string, SerializableContent>) };
		}
		out.push(t);
	}
	return out;
};

const readInline = (node: LegacyNode): JSONInlineBlock => {
	const inline: JSONInlineBlock = { type: String(node.getAttr('type') ?? 'inline') };
	const id = node.getAttr('id');
	if (id !== undefined) inline.id = String(id);
	const data = node.getAttr('data');
	if (data != null && typeof data === 'object') {
		inline.data = cloneJson(data) as JSONInlineBlock['data'];
	}
	return inline;
};

const readBlock = (node: LegacyNode): JSONBlock => {
	const block: JSONBlock = { type: String(node.getAttr('type') ?? 'paragraph') };
	const id = node.getAttr('id');
	if (id !== undefined) block.id = String(id);
	const data = node.getAttr('data');
	if (data != null && typeof data === 'object') {
		block.data = cloneJson(data) as JSONBlock['data'];
	} else {
		block.data = {};
	}
	const content = node.getAttr('content') as LegacyNode | undefined;
	if (content != null && content._legacyTypeRef === Y_ARRAY_REF) {
		const items: (JSONText | JSONInlineBlock)[] = [];
		for (let i = 0; i < content.length; i++) {
			const part = content.get(i) as LegacyNode;
			if (part._legacyTypeRef === Y_TEXT_REF) {
				items.push(...readText(part));
			} else if (part._legacyTypeRef === Y_MAP_REF) {
				items.push(readInline(part));
			}
		}
		if (items.length > 0) block.content = items;
	}
	const children = node.getAttr('children') as LegacyNode | undefined;
	if (children != null && children._legacyTypeRef === Y_ARRAY_REF && children.length > 0) {
		const kids: JSONBlock[] = [];
		for (let i = 0; i < children.length; i++) {
			kids.push(readBlock(children.get(i) as LegacyNode));
		}
		block.children = kids;
	}
	return block;
};

/**
 * Bind the legacy reader to the engine module. `readLegacyJSON(updates)`
 * applies the stored v1 update rows to a scratch doc (in order — pending
 * offline rows are simply later rows) and materializes the logical JSONDoc.
 * The scratch doc is discarded; nothing is written back to any store.
 */
export const bindLegacyReader = (Y: EngineApi) => {
	/**
	 * Materialize the logical JSON of a legacy v13 document from its stored
	 * update rows. Throws when the decoded doc is not the v13 Edytor schema.
	 */
	const readLegacyJSON = (updates: Uint8Array[]): JSONDoc => {
		const doc = new Y.Doc() as unknown as EngineDoc;
		Y.transact(doc as YDocType, () => {
			for (const update of updates) {
				Y.applyUpdate(doc as YDocType, update);
			}
		});
		// Fail closed on un-integratable rows: pendingStructs/pendingDs are
		// non-null while CRDT dependencies are missing — the materialized
		// JSON would silently omit that content (gate-2 migration probe).
		const pending = doc.store?.pendingStructs ?? null;
		const pendingDs = doc.store?.pendingDs ?? null;
		if (pending !== null || pendingDs !== null) {
			throw new PendingLegacyUpdatesError(
				pending?.missing ?? new Map<number, number>(),
				pendingDs !== null
			);
		}
		return readLegacyJSONFromDoc(doc);
	};

	/**
	 * Materialize from an already-populated doc (e.g. one built by tests).
	 * Throws when the doc is not the v13 Edytor schema.
	 */
	const readLegacyJSONFromDoc = (doc: EngineDoc): JSONDoc => {
		if (!isLegacyDoc(doc)) {
			throw new Error(
				'Not a legacy v13 Edytor document: missing `content` root with a sequence `children` attribute.'
			);
		}
		const root = doc.get(LEGACY_ROOT_KEY) as LegacyNode;
		const children = root.getAttr('children') as LegacyNode;
		const out: JSONBlock[] = [];
		for (let i = 0; i < children.length; i++) {
			out.push(readBlock(children.get(i) as LegacyNode));
		}
		return { children: out };
	};

	return { readLegacyJSON, readLegacyJSONFromDoc, isLegacyDoc };
};

// local alias so readLegacyJSON can call Y.transact with the engine doc type
type YDocType = InstanceType<EngineApi['Doc']>;
