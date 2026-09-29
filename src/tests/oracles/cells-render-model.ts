/**
 * arch-v2 R1/R2 — what a view renders, compared with a from-scratch build
 * (plan §9.1 rule 3, §9.3 R1, R2; K7).
 *
 * Since R2 the components render the view's own cells (`edytor.cells`), so
 * the R1 mirror side is gone: what remains is the document side. The render
 * model of the live cells (type, data, child list; each segment's render
 * deltas with the kind's `transformText`, filler and trailing newline; each
 * atom; the placeholder attribute) must equal the one of a cell tree built
 * from scratch from the projection. A difference is a cells or change-report
 * bug (K7) and is never explained. Shared by the dom-lane shadow
 * (`src/tests/dom/cellsShadow.ts`) and the browser route (`/test/dom?cells`).
 * Temporary: removed at R4.
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

const cellsModel = (edytor: Any, cells: Any): BlockModel[] => {
	const { partsOf, segmentDeltas, placeholderOf } = cellsLib!;
	const composingIn = edytor.isComposing ? (edytor.composition.host?.parent?.id ?? null) : null;
	const walk = (id: string): BlockModel => {
		const cell = cells.get(id);
		if (!cell) {
			return { id, type: '(no cell)', data: {}, children: [], parts: [], placeholder: false };
		}
		const transform = edytor.definitionOf(cell.type)?.transformText;
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

/** R1's mirror/cells classes: none remain once the components render the cells (R2). */
export const CLASSES: { name: string; row: string }[] = [];

export type Verdict = {
	/** Differences found (both sides). */
	differences: number;
	/** Explained differences per class name. */
	byClass: Record<string, number>;
	/** Differences no class explains (every `document`-side one included). */
	unexplained: Difference[];
};

/** Compare the cells `edytor` renders with a from-scratch build; every difference is unexplained. */
export const compareView = (edytor: Any, cells: Any): Verdict => {
	const differences: Difference[] = [];
	try {
		diffModels(
			'document',
			cellsModel(edytor, freshCells(edytor)),
			cellsModel(edytor, cells),
			differences
		);
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
	verdict.unexplained.push(...differences);
	return verdict;
};
