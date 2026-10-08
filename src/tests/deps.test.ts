/**
 * The contexts of src/lib form no cycle between them (AGENTS.md "The
 * top-level model"). `scripts/deps.mjs` builds the value-import graph of
 * src/lib (vendored engine excluded) and finds its strongly connected
 * components (Tarjan); each module belongs to one context
 * (`scripts/contexts.mjs`). A component whose modules belong to more than
 * one context means two contexts depend on each other: the dependency must
 * be inverted (a port the composition root implements) or the module
 * reassigned. Expected values come from the layering the guide states: the
 * session never value-imports the surface, the chrome or the root, and the
 * surface never imports the chrome or the root.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as deps from '../../scripts/deps.mjs';

type Graph = { nodes: string[]; edges: Map<string, Map<string, 'static' | 'dynamic'>> };
type Cycle = { members: string[]; contexts: string[] };
const { buildGraph, contextOf, crossingCycles, forbiddenEdges, specifiersOf, tarjan, unassigned } =
	deps as unknown as {
		buildGraph: () => Graph;
		contextOf: (rel: string) => string | null;
		crossingCycles: (graph?: Graph) => Cycle[];
		forbiddenEdges: (graph?: Graph) => string[];
		specifiersOf: (code: string) => [string, 'static' | 'dynamic'][];
		tarjan: (nodes: string[], next: (node: string) => Iterable<string>) => string[][];
		unassigned: (graph?: Graph) => string[];
	};

describe('the dependency check itself', () => {
	it('finds strongly connected components (Tarjan)', () => {
		const graph: Record<string, string[]> = {
			a: ['b'],
			b: ['c'],
			c: ['a', 'd'],
			d: ['e'],
			e: ['d'],
			f: []
		};
		const components = tarjan(Object.keys(graph), (n) => graph[n]!)
			.map((c) => c.join())
			.sort();
		expect(components).toEqual(['a,b,c', 'd,e', 'f']);
	});

	it('counts value imports only', () => {
		const code = `
			import type { A } from './a.js';
			import { type B, type C } from './b.js';
			import { D, type E } from './d.js';
			import * as F from './f.js';
			import './g.js';
			export type { H } from './h.js';
			export { I } from './i.js';
			export * from './j.js';
			const k = () => import('./k.js');
		`;
		expect(specifiersOf(code)).toEqual([
			['./d.js', 'static'],
			['./f.js', 'static'],
			['./g.js', 'static'],
			['./i.js', 'static'],
			['./j.js', 'static'],
			['./k.js', 'dynamic']
		]);
	});

	it('assigns the view directories to the contexts the guide names', () => {
		expect(contextOf('session/composition.svelte.ts')).toBe('session');
		expect(contextOf('selection/replaceSelection.ts')).toBe('session');
		expect(contextOf('selection/visibility.ts')).toBe('session');
		expect(contextOf('block/block.svelte.ts')).toBe('session');
		expect(contextOf('text/text.svelte.ts')).toBe('session');
		expect(contextOf('clipboard/htmlFlow.ts')).toBe('session');
		expect(contextOf('selection/selection.svelte.ts')).toBe('surface');
		expect(contextOf('selection/domSelection.ts')).toBe('surface');
		expect(contextOf('events/onKeyDown.ts')).toBe('surface');
		expect(contextOf('components/Block.svelte')).toBe('surface');
		expect(contextOf('components/Edytor.svelte')).toBe('root');
		expect(contextOf('edytor.svelte.ts')).toBe('root');
		expect(contextOf('crdt/edytor-doc.ts')).toBe('doc');
		expect(contextOf('crdt/providers/websocket.ts')).toBe('sync');
		expect(contextOf('plugins/toolbar/ToolbarController.svelte.ts')).toBe('plugins');
	});
});

describe('src/lib', () => {
	const graph = buildGraph();

	it('every module belongs to a context', () => {
		expect(unassigned(graph)).toEqual([]);
	});

	it('no cycle crosses contexts', () => {
		expect(crossingCycles(graph)).toEqual([]);
	});

	it('the session reaches neither the surface, the chrome nor the root; the surface neither the chrome nor the root', () => {
		expect(forbiddenEdges(graph)).toEqual([]);
	});

	it('the lint rule refuses a session value import of the surface, never a type import', async () => {
		const { ESLint } = await import('eslint');
		const root = join(import.meta.dirname, '../..');
		const eslint = new ESLint({ cwd: root });
		const code = [
			"import { onKeyDown } from '$lib/events/onKeyDown.js';",
			"import type { Projector } from '$lib/surface/projector.svelte.js';",
			"import { type Overlay } from '$lib/surface/overlay.js';",
			"import { caretAt } from '$lib/session/attempt.js';",
			'export const used = [onKeyDown, caretAt] as unknown as [Projector, Overlay];',
			''
		].join('\n');
		const [result] = await eslint.lintText(code, {
			filePath: join(root, 'src/lib/session/context-imports-fixture.ts')
		});
		const lines = result!.messages
			.filter((m) => m.ruleId === 'edytor-contexts/context-imports')
			.map((m) => m.line);
		expect(lines).toEqual([1]);
	});
});
