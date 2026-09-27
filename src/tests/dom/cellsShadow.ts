/**
 * arch-v2 R1 — the render-cells shadow in the dom lane (plan §9.1 rule 3,
 * §9.3 R1).
 *
 * Every view gets a cell tree (`surface/cells`) seeded from its document's
 * projection and patched only from the document's change reports, next to
 * today's wrapper mirror. After each step — the end of every synchronous
 * turn in which a report was applied, every `flushDomUpdates()`, and the end
 * of every test — `compareView` (`src/tests/oracles/cells-render-model.ts`)
 * compares what the mirror renders with what the cells render, and the cells
 * with a from-scratch build. A difference no §8 class explains fails the test
 * (`endCellsShadowTest`). Census: `CELLS_SHADOW_REPORT=/abs/file.jsonl
 * pnpm test:dom` appends one line per test file.
 * Temporary: removed at R4 with the mirror it compares against.
 */
import { appendFileSync } from 'node:fs';
import { expect } from 'vitest';
import { CLASSES, cellsLib, compareView } from '../oracles/cells-render-model.js';

// Loosely typed: the shadow holds views and cell trees without importing their modules.
type Any = any;

type Shadow = { edytor: Any; cells: Any };

const shadows = new Set<Shadow>();
const seen = new WeakSet<object>();

const register = (edytor: Any) => {
	if (edytor.destroyed) return;
	let facade: Any;
	try {
		facade = edytor.facade;
	} catch {
		return;
	}
	shadows.add({ edytor, cells: cellsLib!.createCells(facade, scheduleTurn) });
};

/**
 * Discovery: the first `facade` read of a view (made while it is constructed)
 * queues its registration for the end of the turn, once construction is over.
 * Installed from the lane's `beforeEach`, after the test file has loaded the
 * runtime: importing it from the setup file would load `src/lib` before a
 * test file's own harness (the virtual clock of the determinism probes).
 */
let installed = false;
export const installCellsShadow = async () => {
	if (installed || !cellsLib) return;
	installed = true;
	const { Edytor } = await import('$lib/edytor.svelte.js');
	const facade = Object.getOwnPropertyDescriptor(Edytor.prototype, 'facade')!.get!;
	Object.defineProperty(Edytor.prototype, 'facade', {
		configurable: true,
		get() {
			if (!seen.has(this)) {
				seen.add(this);
				queueMicrotask(() => register(this));
			}
			return facade.call(this);
		}
	});
};

let turnScheduled = false;
function scheduleTurn() {
	if (turnScheduled) return;
	turnScheduled = true;
	queueMicrotask(() => {
		turnScheduled = false;
		compareAllCells('turn');
	});
}

// ── steps and census ────────────────────────────────────────────────────

type Census = {
	steps: number;
	differing: number;
	byClass: Record<string, { row: string; steps: number; differences: number }>;
	unexplained: object[];
};

const emptyCensus = (): Census => ({ steps: 0, differing: 0, byClass: {}, unexplained: [] });
let census = emptyCensus();
let testUnexplained: object[] = [];

const compareOne = (shadow: Shadow, kind: string) => {
	const { edytor } = shadow;
	if (edytor.destroyed) {
		shadow.cells.dispose();
		shadows.delete(shadow);
		return;
	}
	if (!edytor.root) return;
	census.steps++;
	const verdict = compareView(edytor, shadow.cells);
	if (verdict.differences === 0) return;
	census.differing++;
	for (const [name, differences] of Object.entries(verdict.byClass)) {
		const row = CLASSES.find((c) => c.name === name)!.row;
		const entry = (census.byClass[name] ??= { row, steps: 0, differences: 0 });
		entry.steps++;
		entry.differences += differences;
	}
	if (verdict.unexplained.length) {
		const record = {
			kind,
			test: expect.getState().currentTestName ?? null,
			composing: edytor.isComposing ? (edytor.compositionText?.parent?.id ?? '(none)') : null,
			differences: verdict.unexplained.slice(0, 6)
		};
		testUnexplained.push(record);
		census.unexplained.push(record);
	}
};

export const compareAllCells = (kind: string) => {
	for (const shadow of [...shadows]) compareOne(shadow, kind);
};

/** Test end: compare, dispose every shadow, and fail on a difference no §8 row explains. */
export const endCellsShadowTest = () => {
	compareAllCells('test end');
	for (const shadow of shadows) shadow.cells.dispose();
	shadows.clear();
	const unexplained = testUnexplained;
	testUnexplained = [];
	expect(unexplained, 'render-cells shadow: differences no §8 row explains').toEqual([]);
};

export const reportCellsCensus = (file: string) => {
	const out = process.env.CELLS_SHADOW_REPORT;
	if (out && census.steps > 0) {
		appendFileSync(
			out,
			JSON.stringify({
				file,
				...census,
				unexplained: census.unexplained.length,
				samples: census.unexplained.slice(0, 20)
			}) + '\n'
		);
	}
	census = emptyCensus();
};
