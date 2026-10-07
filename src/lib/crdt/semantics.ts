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
import type { MarkEdge } from './text/marks.js';

/** One kind's structural row — the fields of its `BlockDefinition` a document adopts. */
export type KindSemantics = BlockRole & { rendersContent?: boolean; defaultChild?: string };

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
 * Kind tables (`type → row`) as one {@link DocumentSemanticsConfig}, deeply
 * frozen: `semanticsOf({ embed: { void: true, rendersContent: false } })`.
 * To add kinds to a bundled config, merge `roles`, `rendersContent` and
 * `defaultChild` field by field
 * (`roles: { ...defaultSemantics.roles, ...mine.roles }`, and so on): a
 * top-level spread of two configs keeps only the last one's fields and
 * drops the bundled void, island and default-child rows.
 */
export const semanticsOf = (...tables: Record<string, KindSemantics>[]) => {
	const semantics = {
		roles: {} as Record<string, BlockRole>,
		rendersContent: {} as Record<string, boolean>,
		defaultChild: {} as Record<string, string>
	} satisfies DocumentSemanticsConfig;
	for (const [type, { rendersContent, defaultChild, ...role }] of tables.flatMap(Object.entries)) {
		semantics.roles[type] = role;
		if (rendersContent !== undefined) semantics.rendersContent[type] = rendersContent;
		if (defaultChild !== undefined) semantics.defaultChild[type] = defaultChild;
	}
	return frozen(semantics);
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
/** The columns plugin's block roles (a layout of columns). */
export const layoutSemantics = semanticsOf(layoutKinds);
/**
 * The rich-text, code, image and columns plugins' block roles together —
 * what the room adopts by default and what a headless document passes
 * explicitly. The columns plugin is not a default plugin of `<Edytor>`, but
 * its roles are here so a layout reads the same on every replica.
 */
export const defaultSemantics = withMarks(
	semanticsOf(richTextKinds, codeKinds, imageKinds, layoutKinds),
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
