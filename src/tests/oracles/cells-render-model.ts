/**
 * arch-v2 R1 — what a view renders, read two ways, and the classes that
 * explain where they differ (plan §9.1 rule 3, §9.3 R1).
 *
 * - The mirror side is what today's wrappers hand the components:
 *   `Block.children`, `Block.content`, `Text.renderChildren`, `isEmpty`,
 *   `endsWithNewline`, and the placeholder condition of `Text.svelte` without
 *   its DOM-read half (`hasDomText`, L34, retired at R5).
 * - The cell side is the same render model computed from `surface/cells`:
 *   each cell's type, data and child list; each segment's render deltas (the
 *   kind's `transformText` applied), filler and trailing newline; each atom;
 *   the placeholder attribute.
 * - The document side is a cell tree built from scratch from the projection:
 *   patched cells that differ from it are a cells bug (K7), never explained.
 *
 * Every mirror/cells difference must match one of {@link CLASSES}, each tied
 * to a plan §8 row by an objective predicate. Shared by the dom-lane shadow
 * (`src/tests/dom/cellsShadow.ts`) and the browser route (`/test/dom?cells`).
 * Temporary: removed at R4 with the mirror it compares against.
 */
// Loosely typed: the comparator reads the mirror's wrappers and the cell values alike.
type Any = any;

/** The part of `surface/cells` the comparison uses (typed loosely: it may not exist). */
type CellsModule = Record<'createCells' | 'partsOf' | 'segmentDeltas' | 'placeholderOf', Any>;
// Resolved lazily so this file loads on the reference, where the module does not exist yet.
const lib = import.meta.glob<CellsModule>('../../lib/surface/cells.ts', { eager: true });
export const cellsLib: CellsModule | undefined = Object.values(lib)[0];

type PartModel =
	| { kind: 'text'; empty: boolean; newline: boolean; deltas: [string, unknown][] }
	| { kind: 'inline'; id: string; type: string; data: unknown };
type BlockModel = {
	id: string;
	type: string;
	data: unknown;
	children: BlockModel[];
	parts: PartModel[];
	placeholder: boolean;
};

/**
 * One field that differs. `reference` is the mirror's value (side `mirror`)
 * or the from-scratch build's (side `document`); `cells` the patched cells'.
 */
export type Difference = {
	side: 'mirror' | 'document';
	block: string | null;
	field: string;
	reference: unknown;
	cells: unknown;
};

const json = (v: unknown) => JSON.stringify(v ?? {});

const mirrorModel = (edytor: Any): BlockModel[] => {
	const walk = (block: Any): BlockModel => {
		const content: Any[] = block.content;
		return {
			id: block.id,
			type: block.type,
			data: block.data ?? {},
			children: block.children.map(walk),
			parts: content.map((part: Any): PartModel => {
				if ('children' in part) {
					return {
						kind: 'text',
						empty: part.isEmpty,
						newline: part.endsWithNewline,
						deltas: part.isEmpty
							? []
							: part.renderChildren.map((d: Any) => [d.text, d.marks] as [string, unknown])
					};
				}
				return { kind: 'inline', id: part.id, type: part.type, data: part.data ?? {} };
			}),
			placeholder:
				content.length === 1 &&
				'children' in content[0] &&
				content[0].isEmpty &&
				!edytor.isComposing
		};
	};
	return (edytor.root?.children ?? []).map(walk);
};

const cellsModel = (edytor: Any, cells: Any): BlockModel[] => {
	const { partsOf, segmentDeltas, placeholderOf } = cellsLib!;
	const composingIn = edytor.isComposing ? (edytor.compositionText?.parent?.id ?? null) : null;
	const walk = (id: string): BlockModel => {
		const cell = cells.get(id);
		if (!cell) {
			return { id, type: '(no cell)', data: {}, children: [], parts: [], placeholder: false };
		}
		const transform = edytor.getBlockDefinition('block', cell.type)?.transformText;
		return {
			id,
			type: cell.type,
			data: cell.data ?? {},
			children: cell.childIds.map(walk),
			parts: partsOf(cell.runs).map((part: Any): PartModel => {
				if (part.kind === 'inline') {
					return { kind: 'inline', id: part.id, type: part.type, data: part.data ?? {} };
				}
				return {
					kind: 'text',
					empty: part.text === '',
					newline: part.text.endsWith('\n'),
					deltas:
						part.text === ''
							? []
							: segmentDeltas(cell, part, transform).map(
									(d: Any) => [d.text, d.marks] as [string, unknown]
								)
				};
			}),
			placeholder: placeholderOf(cell, composingIn === id)
		};
	};
	return cells.rootIds.map(walk);
};

/** A cell tree built from scratch from the projection (the document side, K7). */
const freshCells = (edytor: Any) =>
	cellsLib!.createCells({ project: () => edytor.facade.project(), onChange: () => () => {} });

const diffModels = (
	side: Difference['side'],
	a: BlockModel[],
	b: BlockModel[],
	out: Difference[],
	parent: string | null = null
) => {
	const ids = (xs: BlockModel[]) => xs.map((x) => x.id);
	if (json(ids(a)) !== json(ids(b))) {
		out.push({ side, block: parent, field: 'children', reference: ids(a), cells: ids(b) });
	}
	const byId = new Map(b.map((x) => [x.id, x]));
	for (const x of a) {
		const y = byId.get(x.id);
		if (!y) continue;
		const push = (field: string, m: unknown, c: unknown) =>
			out.push({ side, block: x.id, field, reference: m, cells: c });
		if (x.type !== y.type) push('type', x.type, y.type);
		if (json(x.data) !== json(y.data)) push('data', x.data, y.data);
		if (x.placeholder !== y.placeholder) push('placeholder', x.placeholder, y.placeholder);
		const shape = (m: BlockModel) =>
			m.parts.map((p) => (p.kind === 'text' ? 'text' : `inline:${p.id}`));
		if (json(shape(x)) !== json(shape(y))) push('parts', shape(x), shape(y));
		else
			x.parts.forEach((p, i) => {
				const q = y.parts[i];
				if (json(p) !== json(q)) push(`part:${i}`, p, q);
			});
		diffModels(side, x.children, y.children, out, x.id);
	}
};

// ── classes: every mirror/cells difference must match a plan §8 row ────

/** The mirror's Text at part `index` of `block`, when that part is a text. */
const mirrorText = (edytor: Any, block: string | null, index: number): Any => {
	const find = (blocks: Any[]): Any => {
		for (const b of blocks) {
			if (b.id === block) return b;
			const hit = find(b.children);
			if (hit) return hit;
		}
		return null;
	};
	const part = find(edytor.root?.children ?? [])?.content[index];
	return part && 'children' in part ? part : null;
};

type Class = { name: string; row: string; matches: (d: Difference, edytor: Any) => boolean };

export const CLASSES: Class[] = [
	{
		// The live composition host renders the mirror's render pin (the DOM the
		// IME anchored to, plus the preview it splices), which lags or leads the
		// committed runs the cell holds. Cells get the pin at I4 (`surface/pin`:
		// the host cell's segment list frozen for the session, one catch-up patch
		// at its end). Predicate: the differing part is the text that serves its
		// pin right now (`Text.renderChildren`'s own condition).
		name: 'composition-pin',
		row: 'F-I10, F-I11 (I4)',
		matches: (d, edytor) => {
			if (!d.field.startsWith('part:')) return false;
			const text = mirrorText(edytor, d.block, Number(d.field.slice(5)));
			return Boolean(text?._pinnedDeltas && edytor.isComposing && edytor.compositionText === text);
		}
	},
	{
		// `Text.svelte` hides every placeholder while any composition is live;
		// the attribute (§2.4) is withheld only in the cell a composition is in.
		// Predicate: a placeholder the mirror hides, in a block other than the
		// composition host, while a composition is live.
		name: 'placeholder-outside-composition-host',
		row: 'F-I15 (§2.4 placeholder attribute; R5)',
		matches: (d, edytor) =>
			d.field === 'placeholder' &&
			d.reference === false &&
			d.cells === true &&
			edytor.isComposing &&
			edytor.compositionText?.parent?.id !== d.block
	}
];

export type Verdict = {
	/** Differences found (both sides). */
	differences: number;
	/** Explained differences per class name. */
	byClass: Record<string, number>;
	/** Differences no class explains (every `document`-side one included). */
	unexplained: Difference[];
};

/** Compare what `edytor` renders with what `cells` render, and classify every difference. */
export const compareView = (edytor: Any, cells: Any): Verdict => {
	const differences: Difference[] = [];
	try {
		diffModels(
			'document',
			cellsModel(edytor, freshCells(edytor)),
			cellsModel(edytor, cells),
			differences
		);
		diffModels('mirror', mirrorModel(edytor), cellsModel(edytor, cells), differences);
	} catch (error) {
		differences.push({
			side: 'mirror',
			block: null,
			field: 'error',
			reference: String(error),
			cells: null
		});
	}
	const verdict: Verdict = { differences: differences.length, byClass: {}, unexplained: [] };
	for (const d of differences) {
		const c = d.side === 'mirror' ? CLASSES.find((k) => k.matches(d, edytor)) : undefined;
		if (c) verdict.byClass[c.name] = (verdict.byClass[c.name] ?? 0) + 1;
		else verdict.unexplained.push(d);
	}
	return verdict;
};
