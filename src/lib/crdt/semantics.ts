/**
 * The bundled plugins' block roles as document semantics (UW-10).
 *
 * Views adopt roles from their plugins' block definitions; a document no
 * view configures — a headless `createDocument`, the Durable Object room —
 * needs them as data. Each table below is the structural row of the kinds a
 * bundled plugin defines (`void`/`island`/`lines`/`layout`, `rendersContent`,
 * `defaultChild`): the `.svelte` plugin spreads its row into the kind's
 * definition, so the view and a document without one read the same facts.
 * Worker-safe: the room imports it.
 */
import type { DocumentSemanticsConfig } from './document.js';
import type { BlockRole } from './edytor-doc.js';
import { hash32 } from './rand.js';
import type { MarkEdge } from './text/marks.js';

/** One kind's structural row — the fields of its `BlockDefinition` a document adopts. */
export type KindSemantics = BlockRole & { rendersContent?: boolean; defaultChild?: string };

/**
 * A kind record as a plugin declares it (`plugin.blocks[type]`): its
 * structural row with whatever else it holds (a snippet, an element,
 * presets), or a bare snippet, a plain kind.
 */
export type KindRecord = KindSemantics | ((...args: never[]) => unknown);

/**
 * Raised when two declarations of one kind's structural facts disagree —
 * a view's plugin and the document (`adoptSemantics`), or two configs
 * {@link mergeSemantics} is given: no replica may silently read another
 * rule than its peers.
 */
export class SemanticConflictError extends Error {
	constructor(
		/** What conflicted (e.g. `block role "divider"`, `defaultType`). */
		public readonly subject: string,
		public readonly existing: unknown,
		public readonly incoming: unknown
	) {
		super(
			`EdytorDocument semantic conflict on ${subject}: ` +
				`${JSON.stringify(existing)} already adopted, refusing ${JSON.stringify(incoming)}.`
		);
		this.name = 'SemanticConflictError';
	}
}

/**
 * A role with every flag answered; `layout` and `atomic` only when set (the
 * bundled kinds' rows stay as they were). Atomic paths as key arrays,
 * deduplicated and sorted, so two declarations of one set compare equal.
 */
export type NormalizedRole = {
	void: boolean;
	island: boolean;
	lines: boolean;
	layout?: true;
	table?: true;
	atomic?: readonly (readonly string[])[];
};

/** `role` as {@link NormalizedRole}: the one form two declarations compare in. */
export const normalizeRole = (role: BlockRole | undefined): NormalizedRole => {
	const atomic = [
		...new Map(
			(role?.atomic ?? []).map((p) => {
				const path = typeof p === 'string' ? [p] : [...p];
				return [JSON.stringify(path), path] as const;
			})
		)
	]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([, path]) => path);
	return {
		void: role?.void === true,
		island: role?.island === true,
		lines: role?.lines === true,
		...(role?.layout === true && { layout: true as const }),
		...(role?.table === true && { table: true as const }),
		...(atomic.length > 0 && { atomic })
	};
};

/** Freeze `value` and everything in it: the tables are shared by every document. */
const frozen = <T>(value: T): T => {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value)) frozen(inner);
	}
	return value;
};

/** `richTextPlugin`'s structural rows (its other kinds are plain). */
export const richTextKinds = frozen({
	divider: { void: true, rendersContent: false },
	horizontalRule: { void: true, rendersContent: false },
	'ordered-list': { rendersContent: false, defaultChild: 'list-item' },
	'unordered-list': { rendersContent: false, defaultChild: 'list-item' }
} satisfies Record<string, KindSemantics>);

/**
 * `richTextPlugin`'s mark edges: where a concurrent insert at each end
 * of a mark lands. A link grows at its start only (typing after it
 * stays out of it unless from inside the anchor); the others are inclusive.
 */
export const richTextMarks = frozen({
	link: { edge: 'side-dependent' }
} satisfies Record<string, { edge: MarkEdge }>);

/** `codePlugin`'s structural rows: the code block is an island of `codeLine`s (`lines`). */
export const codeKinds = frozen({
	code: { island: true, lines: true, rendersContent: false, defaultChild: 'codeLine' }
} satisfies Record<string, KindSemantics>);

/** `imagePlugin`'s structural rows: void, its only text is the caption. */
export const imageKinds = frozen({ image: { void: true } } satisfies Record<string, KindSemantics>);

/**
 * The media plugins' structural rows (`embedPlugin`, `bookmarkPlugin`,
 * `filePlugin`, `videoPlugin`, `audioPlugin`): void like the image, their
 * only text is the caption.
 */
export const mediaKinds = frozen({
	embed: { void: true },
	bookmark: { void: true },
	file: { void: true },
	video: { void: true },
	audio: { void: true }
} satisfies Record<string, KindSemantics>);

/**
 * The page plugin's structural row: a link to another document (a subpage),
 * void and showing no text of its own, as a divider.
 */
export const pageKinds = frozen({
	page: { void: true, rendersContent: false }
} satisfies Record<string, KindSemantics>);

/**
 * The table of contents plugin's structural row: a void that lists the
 * document's headings, showing no text of its own.
 */
export const tocKinds = frozen({
	toc: { void: true, rendersContent: false }
} satisfies Record<string, KindSemantics>);

/**
 * The columns plugin's structural rows: `columns` is a layout of `column`s
 * (`layout.*` in the delete contract), a column a container that holds any
 * block. In {@link defaultSemantics}: a document holding no `columns` block
 * is unchanged by them, and every replica of one that does (a view with the
 * plugin, a headless document, the room) reads the same layout rules.
 */
export const layoutKinds = frozen({
	columns: { layout: true, rendersContent: false, defaultChild: 'column' },
	column: { rendersContent: false }
} satisfies Record<string, KindSemantics>);

/**
 * The table plugin's structural rows: `table` displays only its
 * `tableRow`s, a row only its `tableCell`s, in the order of the table's
 * `data.columns` (`table.*` in the delete contract); a cell is a text
 * island (its text holds its lines, as soft breaks). In
 * {@link defaultSemantics}, so every replica of a document holding a table
 * reads the same rules.
 */
export const tableKinds = frozen({
	table: { table: true, rendersContent: false, defaultChild: 'tableRow' },
	tableRow: { rendersContent: false, defaultChild: 'tableCell' },
	tableCell: { island: true }
} satisfies Record<string, KindSemantics>);

/**
 * Kind tables (`type → row`) as one {@link DocumentSemanticsConfig}, deeply
 * frozen: `semanticsOf({ embed: { void: true, rendersContent: false } })`.
 * A row may be a plugin's kind record (`plugin.blocks`): only its
 * structural fields are read (`void`, `island`, `lines`, `layout`,
 * `table`, `atomic`, `rendersContent`, `defaultChild`), and a bare snippet is a
 * plain kind. To add kinds to a bundled config, use {@link mergeSemantics}.
 */
export const semanticsOf = (...tables: Record<string, KindRecord>[]) => {
	const semantics = {
		roles: {} as Record<string, BlockRole>,
		rendersContent: {} as Record<string, boolean>,
		defaultChild: {} as Record<string, string>
	} satisfies DocumentSemanticsConfig;
	for (const [type, record] of tables.flatMap(Object.entries)) {
		const row: KindSemantics = typeof record === 'object' && record !== null ? record : {};
		const {
			void: isVoid,
			island,
			lines,
			layout,
			table,
			atomic,
			rendersContent,
			defaultChild
		} = row;
		semantics.roles[type] = Object.fromEntries(
			Object.entries({ void: isVoid, island, lines, layout, table, atomic }).filter(
				([, fact]) => fact !== undefined
			)
		);
		if (rendersContent !== undefined) semantics.rendersContent[type] = rendersContent;
		if (defaultChild !== undefined) semantics.defaultChild[type] = defaultChild;
	}
	return frozen(semantics);
};

/** The merged config's fields, each present (empty when no config named one). */
export type MergedSemantics = {
	roles: Record<string, BlockRole>;
	rendersContent: Record<string, boolean>;
	defaultChild: Record<string, string>;
	marks: Record<string, { edge?: MarkEdge }>;
	defaultType?: string;
};

/**
 * Several configs as one, deeply frozen, merged field by field (`roles`,
 * `rendersContent`, `defaultChild`, `marks`, `defaultType`): the room's or
 * a headless document's roles for an app's own kinds beside the bundled
 * ones, `mergeSemantics(defaultSemantics, semanticsOf(myKinds))`. A
 * top-level spread of two configs would keep only the last one's fields.
 * A kind (or mark, or the default type) two configs declare otherwise
 * throws {@link SemanticConflictError}, as a view's conflicting plugin does
 * on a document; an equal declaration merges.
 */
export const mergeSemantics = (...configs: DocumentSemanticsConfig[]): MergedSemantics => {
	const merged: MergedSemantics = { roles: {}, rendersContent: {}, defaultChild: {}, marks: {} };
	const same = {
		roles: (a: BlockRole, b: BlockRole) =>
			JSON.stringify(normalizeRole(a)) === JSON.stringify(normalizeRole(b)),
		rendersContent: (a: boolean, b: boolean) => a === b,
		defaultChild: (a: string, b: string) => a === b,
		marks: (a: { edge?: MarkEdge }, b: { edge?: MarkEdge }) =>
			(a.edge ?? 'inclusive') === (b.edge ?? 'inclusive')
	};
	for (const config of configs) {
		for (const table of ['roles', 'rendersContent', 'defaultChild', 'marks'] as const) {
			const into = merged[table] as Record<string, unknown>;
			const equal = same[table] as (a: unknown, b: unknown) => boolean;
			for (const [key, value] of Object.entries(config[table] ?? {})) {
				if (Object.hasOwn(into, key) && !equal(into[key], value))
					throw new SemanticConflictError(`${table} "${key}"`, into[key], value);
				into[key] = structuredClone(value);
			}
		}
		if (config.defaultType === undefined) continue;
		if (merged.defaultType !== undefined && merged.defaultType !== config.defaultType)
			throw new SemanticConflictError('defaultType', merged.defaultType, config.defaultType);
		merged.defaultType = config.defaultType;
	}
	return frozen(merged);
};

/**
 * A config's facts as one short hash per kind, per mark (`mark:<name>`) and
 * for the default type (`@defaultType`): what a document advertises in its
 * presence in development builds, so the room can name the kinds it reads
 * otherwise than a client ({@link semanticsMismatch}). A plain kind (no
 * role, content, no default child) hashes as an undeclared one.
 */
export const semanticsDigest = (config: DocumentSemanticsConfig): Record<string, string> => {
	const hash = (facts: string) => hash32(facts).toString(36);
	const kinds = new Set([
		...Object.keys(config.roles ?? {}),
		...Object.keys(config.rendersContent ?? {}),
		...Object.keys(config.defaultChild ?? {})
	]);
	const digest: Record<string, string> = {};
	for (const kind of [...kinds].sort()) digest[kind] = hash(kindFacts(config, kind));
	for (const mark of Object.keys(config.marks ?? {}).sort())
		digest[`mark:${mark}`] = hash(markFacts(config, mark));
	digest['@defaultType'] = hash(config.defaultType ?? 'paragraph');
	return digest;
};

/** A kind's structural facts as one canonical line (`''` for a plain or unknown kind). */
const kindFacts = (config: DocumentSemanticsConfig, kind: string): string => {
	const own = <T>(table: Record<string, T> = {}) =>
		Object.hasOwn(table, kind) ? table[kind] : undefined;
	const role = normalizeRole(own(config.roles));
	const child = own(config.defaultChild);
	return [
		role.void && 'void',
		role.island && 'island',
		role.lines && 'lines',
		role.layout && 'layout',
		role.table && 'table',
		role.atomic && `atomic=${JSON.stringify(role.atomic)}`,
		own(config.rendersContent) === false && 'no-content',
		child !== undefined && `child=${child}`
	]
		.filter(Boolean)
		.join(' ');
};

/** A mark's edge (`inclusive` when undeclared). */
const markFacts = (config: DocumentSemanticsConfig, mark: string): string =>
	(Object.hasOwn(config.marks ?? {}, mark) ? config.marks?.[mark]?.edge : undefined) ?? 'inclusive';

/**
 * The keys of a client's advertised digest that `ours` (the room's
 * {@link semanticsDigest}) hashes otherwise: kinds, marks or the default
 * type the two read differently. A kind the client does not name is not
 * its mismatch (a view without that plugin); a kind only the client
 * names counts when it has facts. Anything but a digest compares nothing.
 */
export const semanticsMismatch = (ours: Record<string, string>, theirs: unknown): string[] => {
	if (typeof theirs !== 'object' || theirs === null || Array.isArray(theirs)) return [];
	const entries = Object.entries(theirs);
	if (!entries.every(([, hash]) => typeof hash === 'string')) return [];
	const plain = hash32('').toString(36);
	return entries
		.filter(([key, hash]) => {
			if (Object.hasOwn(ours, key)) return ours[key] !== hash;
			if (key === '@defaultType') return false;
			return hash !== (key.startsWith('mark:') ? hash32('inclusive').toString(36) : plain);
		})
		.map(([key]) => key)
		.sort();
};

/** `config` with a mark-edge table (H5), frozen. */
const withMarks = <C extends object>(config: C, marks: Record<string, { edge: MarkEdge }>) =>
	frozen(Object.assign({}, config, { marks }));

/** `richTextPlugin`'s block roles and mark edges, for `createDocument({ semantics })` and the room. */
export const richTextSemantics = withMarks(semanticsOf(richTextKinds), richTextMarks);
/** `codePlugin`'s block roles. */
export const codeSemantics = semanticsOf(codeKinds);
/** `imagePlugin`'s block roles. */
export const imageSemantics = semanticsOf(imageKinds);
/** The media plugins' block roles (embed, bookmark, file, video, audio). */
export const mediaSemantics = semanticsOf(mediaKinds);
/** The columns plugin's block roles (a layout of columns). */
export const layoutSemantics = semanticsOf(layoutKinds);
/** The page plugin's block role (a link to another document). */
export const pageSemantics = semanticsOf(pageKinds);
/** The table of contents plugin's block role. */
export const tocSemantics = semanticsOf(tocKinds);
/** The table plugin's block roles (a table of rows of cells). */
export const tableSemantics = semanticsOf(tableKinds);
/**
 * The rich-text, code, image, media, columns, page, table of contents and
 * table plugins' block roles together — what the room and a headless
 * `createDocument`/`loadDocument` adopt by default (`semantics: {}` checks
 * none). The media, columns, page, table of contents and table plugins are
 * not default plugins of `<Edytor>`, but their roles are here so their
 * blocks read the same on every replica.
 */
export const defaultSemantics = withMarks(
	semanticsOf(
		richTextKinds,
		codeKinds,
		imageKinds,
		mediaKinds,
		layoutKinds,
		pageKinds,
		tocKinds,
		tableKinds
	),
	richTextMarks
);

/**
 * The facade configuration (`EdytorDocConfig`) a document with no view
 * reads `semantics` with — the room's, and a generation cutover's
 * (`migration/generation.ts`): roles, default children, content-less kinds
 * and mark edges, each answered only for a kind the tables name.
 */
export const facadeConfigOf = (semantics: DocumentSemanticsConfig) => {
	const own =
		<T>(table: Record<string, T> = {}) =>
		(type: string): T | undefined =>
			Object.hasOwn(table, type) ? table[type] : undefined;
	const rendersContent = own(semantics.rendersContent);
	const marks = own(semantics.marks);
	return {
		roleOf: own(semantics.roles),
		kinds: () => Object.keys(semantics.roles ?? {}),
		defaultChildOf: own(semantics.defaultChild),
		rendersContent: (type: string) => rendersContent(type) ?? true,
		markEdge: (mark: string) => marks(mark)?.edge,
		defaultType: semantics.defaultType
	};
};
