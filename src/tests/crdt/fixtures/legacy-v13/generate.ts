/**
 * Builders for the durable yjs@13 binary fixtures captured in U00.
 *
 * Each fixture is produced by writing the v13 Edytor schema directly with
 * yjs@13 APIs — root Y.Map 'content', the 'INITIALIZED' Y.Text marker, Y.Map
 * blocks carrying {type, id, data, children, content}, content arrays mixing
 * Y.Text and Y.Map inline blocks, and mark formatting via Y.Text attributes —
 * so the persisted bytes exercise the exact schema the v14 migration has to
 * read. The live v13 `Edytor` runtime no longer exists (U08 moved the runtime
 * to the v14 facade and `EdytorDoc.create` rejects foreign docs), so fixture
 * generation constructs the legacy structure by hand instead of driving the
 * old model stack.
 *
 * Decoding goes through the v14 legacy reader (`migration/legacy-schema.ts`) —
 * the same path real migrations use — so `expected`/`expectedAfterPending` are
 * self-verifying: they are whatever the migration reader materializes from the
 * generated update, never a hand-maintained copy.
 *
 * This module is intentionally free of node:fs and vitest imports so it can be
 * reused by future tooling; legacy-v13.test.ts owns persistence + assertions.
 */
import * as Y from 'yjs';
import { Y as Y14 } from '$lib/crdt/engine.js';
import { bindLegacyReader } from '$lib/crdt/migration/legacy-schema.js';
import { id } from '$lib/utils.js';
import type { JSONBlock, JSONDoc, JSONInlineBlock, JSONText } from '$lib/utils/json.js';

export const LEGACY_V13_ENGINE = {
	yjs: '13.6.30',
	lib0: '0.2.117'
} as const;

export type LegacyFixturePending = {
	/** Incremental update produced by an offline peer, encoded against `stateVector`. */
	update: Uint8Array;
	/** Expected logical doc after `update` then `pending.update` are both applied. */
	expectedAfterPending: JSONDoc;
	description: string;
};

export type LegacyFixture = {
	name: string;
	description: string;
	/** Y.encodeStateAsUpdate(doc) of the source document (v1 update format). */
	update: Uint8Array;
	/** Y.encodeStateVector(doc) captured at the same moment. */
	stateVector: Uint8Array;
	/** Expected logical doc after applying `update` to a fresh v13 Y.Doc. */
	expected: JSONDoc;
	/** clientID of the source doc (provenance only; not stable across regeneration). */
	sourceClientId: number;
	pending?: LegacyFixturePending;
};

const legacyReader = bindLegacyReader(Y14);

// ── v13 schema writers ────────────────────────────────────────────────────

/**
 * v13 `Text` — a Y.Text whose logical id lives in a type-level attribute
 * (`yText.setAttribute('id', …)`); marks are insert/format attributes.
 */
const newLegacyText = (content: string | JSONText[] = ''): Y.Text => {
	const text = new Y.Text();
	text.setAttribute('id', id('t'));
	if (typeof content === 'string') {
		if (content.length > 0) {
			text.insert(0, content);
		}
	} else {
		// Track the offset ourselves — reading `length` on a detached Y.Text
		// trips yjs's "Add Yjs type to a document before reading data" warning.
		let offset = 0;
		for (const part of content) {
			if (part.text.length > 0) {
				text.insert(offset, part.text, part.marks as Record<string, unknown> | undefined);
				offset += part.text.length;
			}
		}
	}
	return text;
};

/** v13 `InlineBlock` — a Y.Map carrying {type, id, data} attrs. */
const newLegacyInline = (part: JSONInlineBlock): Y.Map<unknown> =>
	new Y.Map(
		Object.entries({
			type: part.type,
			id: part.id ?? id('i'),
			data: part.data ?? {}
		})
	);

/**
 * v13 `content` array — mixes Y.Text parts and Y.Map inlines under the
 * normalizeContent invariants: starts/ends with a Y.Text (empty separators
 * inserted as needed) and consecutive JSONText parts merge into ONE Y.Text
 * via per-segment format attributes (`groupContent`).
 */
const buildContentArray = (
	content: (JSONText | JSONInlineBlock)[] | undefined
): Y.Array<Y.Text | Y.Map<unknown>> => {
	const parts: (Y.Text | Y.Map<unknown>)[] = [];
	let pendingText: JSONText[] = [];
	const flushText = () => {
		if (pendingText.length > 0) {
			parts.push(newLegacyText(pendingText));
			pendingText = [];
		} else if (parts.length === 0 || !(parts[parts.length - 1] instanceof Y.Text)) {
			parts.push(newLegacyText(''));
		}
	};
	for (const part of content ?? []) {
		if ('type' in part) {
			flushText();
			parts.push(newLegacyInline(part));
		} else {
			pendingText.push(part);
		}
	}
	flushText();
	return Y.Array.from(parts);
};

/** v13 `Block` — a Y.Map carrying {type, id, data, children, content}. */
const newLegacyBlock = (block: JSONBlock): Y.Map<unknown> =>
	new Y.Map(
		Object.entries({
			type: block.type,
			id: block.id ?? id('b'),
			data: block.data ?? {},
			children: Y.Array.from((block.children ?? []).map(newLegacyBlock)),
			content: buildContentArray(block.content)
		})
	);

/** The v13 document root: `doc.getMap('content')` + the INITIALIZED marker. */
const writeLegacyRoot = (doc: Y.Doc, children: JSONBlock[]): Y.Array<Y.Map<unknown>> => {
	const root = doc.getMap('content');
	const yChildren = Y.Array.from(children.map(newLegacyBlock));
	root.set('id', 'root');
	root.set('type', 'root');
	root.set('data', {});
	root.set('children', yChildren);
	root.set('content', new Y.Array());
	// v13 `Edytor.sync()` stamped the init marker into `doc.getText`.
	const marker = doc.getText('INITIALIZED');
	marker.delete(0, marker.length);
	marker.insert(0, 'INITIALIZED');
	return yChildren;
};

/** Build a v13 Y.Doc holding `value` under the legacy Edytor schema. */
const legacyDocFromJSON = (value: JSONDoc): Y.Doc => {
	const doc = new Y.Doc();
	doc.transact(() => {
		writeLegacyRoot(doc, value.children);
	});
	return doc;
};

/** The 'children' array of a block/root Y.Map. */
const childrenOf = (yBlock: Y.Map<unknown>): Y.Array<Y.Map<unknown>> =>
	yBlock.get('children') as Y.Array<Y.Map<unknown>>;

/** The 'content' array of a block Y.Map. */
const contentOf = (yBlock: Y.Map<unknown>): Y.Array<Y.Text | Y.Map<unknown>> =>
	yBlock.get('content') as Y.Array<Y.Text | Y.Map<unknown>>;

/** First Y.Text part of a root-level block's content. */
const firstTextOf = (rootChildren: Y.Array<Y.Map<unknown>>, blockIndex: number): Y.Text => {
	const part = contentOf(rootChildren.get(blockIndex)).get(0);
	if (!(part instanceof Y.Text)) {
		throw new Error(`fixture build: block ${blockIndex} has no leading text`);
	}
	return part;
};

/**
 * Decodes a persisted fixture update the way a v14 reader/migration sees it:
 * apply the update rows to a scratch v14 doc (unified Y.Node decode), then
 * materialize the logical JSON through the legacy-schema reader — the same
 * path `crdt.migration` uses. Applying an update whose CRDT dependencies are
 * missing fails closed with `PendingLegacyUpdatesError` instead of silently
 * truncating the document.
 */
export const decodeFixtureValue = (update: Uint8Array, pending?: Uint8Array): JSONDoc =>
	legacyReader.readLegacyJSON([update, ...(pending ? [pending] : [])]);

const fixtureOf = (
	name: string,
	description: string,
	doc: Y.Doc,
	pending?: LegacyFixturePending
): LegacyFixture => {
	const update = Y.encodeStateAsUpdate(doc);
	return {
		name,
		description,
		update,
		stateVector: Y.encodeStateVector(doc),
		expected: decodeFixtureValue(update),
		sourceClientId: doc.clientID,
		pending
	};
};

const buildNestedMarks = (): LegacyFixture => {
	const doc = legacyDocFromJSON({
		children: [
			{
				type: 'heading',
				data: { level: 1 },
				content: [{ text: 'Release notes', marks: { bold: true } }]
			},
			{
				type: 'paragraph',
				content: [
					{ text: 'plain ' },
					{ text: 'bold', marks: { bold: true } },
					{ text: ' and ' },
					{
						text: 'a link',
						marks: { link: { href: 'https://example.com', target: '_blank' } }
					}
				],
				children: [
					{
						type: 'paragraph',
						content: [{ text: 'nested child', marks: { italic: true } }],
						children: [
							{
								type: 'quote',
								content: [{ text: 'deep quote', marks: { code: true } }]
							}
						]
					}
				]
			},
			{ type: 'paragraph', content: [{ text: 'tail' }] }
		]
	});
	return fixtureOf(
		'nested-marks',
		'Nested block tree (paragraph > paragraph > quote) with boolean marks, an object-valued link mark and block data.',
		doc
	);
};

const buildInlineMentions = (): LegacyFixture => {
	const doc = legacyDocFromJSON({
		children: [
			{
				type: 'paragraph',
				content: [
					{ text: 'Hello ' },
					{ type: 'mention', data: { id: 'u-ada', label: 'Ada' } },
					{ text: ' and ' },
					{ type: 'mention', data: { id: 'u-grace', label: 'Grace' } },
					{ text: 'bye', marks: { bold: true } }
				]
			},
			{
				type: 'paragraph',
				content: [{ type: 'mention', data: { id: 'u-ed', label: 'Ed' } }]
			}
		]
	});
	return fixtureOf(
		'inline-mentions',
		'Inline atoms (mention Y.Map entries) embedded in Y.Array content between Y.Text parts, including leading/trailing separator texts and a block whose only content is an atom.',
		doc
	);
};

const buildTombstones = (): LegacyFixture => {
	const doc = new Y.Doc();
	let rootChildren!: Y.Array<Y.Map<unknown>>;
	doc.transact(() => {
		rootChildren = writeLegacyRoot(doc, [
			{ type: 'paragraph', content: [{ text: 'keep me' }] },
			{ type: 'paragraph', content: [{ text: 'Hello World', marks: { bold: true } }] },
			{
				type: 'paragraph',
				content: [{ text: 'remove me entirely' }],
				children: [{ type: 'paragraph', content: [{ text: 'nested removal' }] }]
			}
		]);
	});

	doc.transact(() => {
		const text = firstTextOf(rootChildren, 1);
		// Delete ' World' -> tombstoned ContentString items remain in the update.
		text.delete(5, 6);
		// Format then unformat -> ContentFormat tombstones alongside live marks.
		text.format(0, 5, { italic: true });
		text.format(0, 5, { italic: null });
	});
	// Removing a block tombstones its whole subtree (map + children array + texts).
	doc.transact(() => {
		rootChildren.delete(2, 1);
	});

	return fixtureOf(
		'tombstones',
		'Inserted-then-deleted characters, applied-then-removed formatting, and a removed subtree. The update retains tombstoned items a decoder must skip.',
		doc
	);
};

const buildOfflinePeer = (): LegacyFixture => {
	// Peer A: the canonical document.
	const docA = legacyDocFromJSON({
		children: [
			{ type: 'paragraph', content: [{ text: 'shared base' }] },
			{ type: 'paragraph', content: [{ text: 'second block', marks: { italic: true } }] }
		]
	});
	const baseUpdate = Y.encodeStateAsUpdate(docA);
	const baseStateVector = Y.encodeStateVector(docA);

	// Peer B: receives A's state, goes offline, then edits. Opening the doc
	// through the Edytor constructor rewrote the INITIALIZED marker, which is
	// itself part of the pending update — that is real product behavior.
	const docB = new Y.Doc();
	Y.applyUpdate(docB, baseUpdate);
	docB.transact(() => {
		const marker = docB.getText('INITIALIZED');
		marker.delete(0, marker.length);
		marker.insert(0, 'INITIALIZED');
		const rootChildren = childrenOf(docB.getMap('content'));
		firstTextOf(rootChildren, 0).insert(11, ' + offline');
		firstTextOf(rootChildren, 1).format(0, 6, { bold: true });
	});
	const pending = Y.encodeStateAsUpdate(docB, baseStateVector);

	return fixtureOf(
		'offline-peer',
		'Base document plus a pending update from an offline peer that synced the base state, then inserted text and added a mark before reconnecting.',
		docA,
		{
			update: pending,
			expectedAfterPending: decodeFixtureValue(baseUpdate, pending),
			description:
				'Y.encodeStateAsUpdate(docB, stateVectorA): the offline peer delta only. Applying it without the base update leaves dangling dependencies; applying it after the base update must converge to expectedAfterPending.'
		}
	);
};

export const generateFixtures = (): LegacyFixture[] => [
	buildNestedMarks(),
	buildInlineMentions(),
	buildTombstones(),
	buildOfflinePeer()
];
