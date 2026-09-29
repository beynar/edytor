/**
 * The bundled plugins' block roles as document semantics (UW-10).
 *
 * Views adopt roles from their plugins' block definitions; a document no
 * view configures — a headless `createDocument`, the Durable Object room —
 * needs them as data. Each table below is the structural row of the kinds a
 * bundled plugin defines (`void`/`island`, `rendersContent`,
 * `defaultChild`): the `.svelte` plugin spreads its row into the kind's
 * definition, so the view and a document without one read the same facts.
 * Worker-safe: the room imports it.
 */
import type { DocumentSemanticsConfig } from './document.js';
import type { BlockRole } from './edytor-doc.js';

/** One kind's structural row — the fields of its `BlockDefinition` a document adopts. */
export type KindSemantics = BlockRole & { rendersContent?: boolean; defaultChild?: string };

/** `richTextPlugin`'s structural rows (its other kinds are plain). */
export const richTextKinds = {
	divider: { void: true, rendersContent: false },
	horizontalRule: { void: true, rendersContent: false },
	'ordered-list': { rendersContent: false, defaultChild: 'list-item' },
	'unordered-list': { rendersContent: false, defaultChild: 'list-item' }
} satisfies Record<string, KindSemantics>;

/** `codePlugin`'s structural rows: the code block is an island of `codeLine`s. */
export const codeKinds = {
	code: { island: true, rendersContent: false, defaultChild: 'codeLine' }
} satisfies Record<string, KindSemantics>;

/** `imagePlugin`'s structural rows: void, its only text is the caption. */
export const imageKinds = { image: { void: true } } satisfies Record<string, KindSemantics>;

/** Kind tables (`type → row`) as one {@link DocumentSemanticsConfig}. */
const semanticsOf = (...tables: Record<string, KindSemantics>[]) => {
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
	return semantics;
};

/** `richTextPlugin`'s block roles, for `createDocument({ semantics })` and the room. */
export const richTextSemantics = semanticsOf(richTextKinds);
/** `codePlugin`'s block roles. */
export const codeSemantics = semanticsOf(codeKinds);
/** `imagePlugin`'s block roles. */
export const imageSemantics = semanticsOf(imageKinds);
/**
 * The rich-text, code and image plugins' block roles together — what the
 * room adopts by default and what a headless document passes explicitly.
 */
export const defaultSemantics = semanticsOf(richTextKinds, codeKinds, imageKinds);
