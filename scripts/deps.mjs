// Value-import graph of src/lib and its strongly connected components.
//
//   node scripts/deps.mjs [--all] [--json] [--cross] [--edges <module>] [--between [<from> <to>]]
//
// Every module of src/lib (the vendored engine excluded) is a node; every
// static value import or re-export of another src/lib module is an edge
// (`import type`, `export type` and imports whose every specifier is a type
// are not; neither are bare packages). A dynamic `import()` is an edge too:
// it couples the modules even if it breaks the load-order cycle.
//
// Each module belongs to one context (`CONTEXTS` in scripts/contexts.mjs,
// the table in AGENTS.md "The top-level model"). Tarjan's algorithm finds
// the strongly connected components; a component whose members belong to
// more than one context is a cycle across contexts. The script exits 1 when
// it finds one, a module no context claims, or an import `FORBIDDEN` rules
// out (`src/tests/deps.test.ts` runs the same checks).
//
// `--all` also prints the cycles inside one context; `--cross` the edges of
// each crossing cycle that leave their context (the imports to invert);
// `--edges <module>` a module's value imports and importers (paths relative
// to src/lib); `--between [<from> <to>]` the imports from one context into
// another (alone: every pair).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { CONTEXTS, FORBIDDEN, LIB, ROOT, contextOf, relOf, resolveModule } from './contexts.mjs';

export { CONTEXTS, FORBIDDEN, LIB, ROOT, contextOf };

/** Never a node: the vendored engine (its own upstream graph). */
const EXCLUDED = [/^crdt\/vendor\//];

const SOURCE = /\.(ts|js|svelte)$/;
const isSource = (rel) =>
	SOURCE.test(rel) && !/\.d\.ts$/.test(rel) && !EXCLUDED.some((re) => re.test(rel));

const walk = (dir, out = []) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
};

const rel = relOf;

/** The script blocks of a Svelte component, joined (markup imports nothing). */
const scriptOf = (text) =>
	[...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

const typeOnlyImport = (node) => {
	const clause = node.importClause;
	if (!clause) return false; // a side-effect import
	if (clause.isTypeOnly) return true;
	if (clause.name) return false;
	const bindings = clause.namedBindings;
	if (!bindings) return false;
	if (ts.isNamespaceImport(bindings)) return false;
	return bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
};

const typeOnlyExport = (node) => {
	if (node.isTypeOnly) return true;
	const clause = node.exportClause;
	if (!clause || !ts.isNamedExports(clause)) return false;
	return clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
};

/** The value specifiers a module imports: `[specifier, 'static' | 'dynamic']`. */
export const specifiersOf = (code, fileName = 'module.ts') => {
	const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
	const out = [];
	const visit = (node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			if (!typeOnlyImport(node)) out.push([node.moduleSpecifier.text, 'static']);
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			if (!typeOnlyExport(node)) out.push([node.moduleSpecifier.text, 'static']);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			out.push([node.arguments[0].text, 'dynamic']);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return out;
};

/** `{ nodes: string[], edges: Map<string, Map<string, 'static' | 'dynamic'>> }` */
export const buildGraph = () => {
	const files = walk(LIB).filter((f) => isSource(rel(f)));
	const known = new Set(files.map(rel));
	const edges = new Map();
	for (const file of files) {
		const text = fs.readFileSync(file, 'utf8');
		const code = file.endsWith('.svelte') ? scriptOf(text) : text;
		const targets = new Map();
		for (const [spec, how] of specifiersOf(code, file.replace(/\.svelte$/, '.svelte.ts'))) {
			const target = resolveModule(file, spec, (candidate) => known.has(rel(candidate)));
			if (target && target !== rel(file) && targets.get(target) !== 'static') {
				targets.set(target, how);
			}
		}
		edges.set(rel(file), targets);
	}
	return { nodes: [...known].sort(), edges };
};

/** Tarjan's strongly connected components (iterative), each sorted. */
export const tarjan = (nodes, successors) => {
	let index = 0;
	const indexOf = new Map();
	const low = new Map();
	const onStack = new Set();
	const stack = [];
	const components = [];
	for (const start of nodes) {
		if (indexOf.has(start)) continue;
		const work = [[start, successors(start)[Symbol.iterator]()]];
		indexOf.set(start, index);
		low.set(start, index++);
		stack.push(start);
		onStack.add(start);
		while (work.length) {
			const [node, it] = work[work.length - 1];
			const next = it.next();
			if (!next.done) {
				const w = next.value;
				if (!indexOf.has(w)) {
					indexOf.set(w, index);
					low.set(w, index++);
					stack.push(w);
					onStack.add(w);
					work.push([w, successors(w)[Symbol.iterator]()]);
				} else if (onStack.has(w)) {
					low.set(node, Math.min(low.get(node), indexOf.get(w)));
				}
				continue;
			}
			work.pop();
			if (work.length) {
				const parent = work[work.length - 1][0];
				low.set(parent, Math.min(low.get(parent), low.get(node)));
			}
			if (low.get(node) === indexOf.get(node)) {
				const component = [];
				let w;
				do {
					w = stack.pop();
					onStack.delete(w);
					component.push(w);
				} while (w !== node);
				components.push(component.sort());
			}
		}
	}
	return components;
};

/** Every cycle of the graph: components of more than one module. */
export const cycles = (graph = buildGraph()) =>
	tarjan(graph.nodes, (n) => graph.edges.get(n)?.keys() ?? [])
		.filter((c) => c.length > 1)
		.map((members) => ({
			members,
			contexts: [...new Set(members.map((m) => contextOf(m) ?? '?'))].sort()
		}));

/** The cycles whose members belong to more than one context. */
export const crossingCycles = (graph = buildGraph()) =>
	cycles(graph).filter((c) => c.contexts.length > 1);

/** Modules no context claims (a new directory must be assigned). */
export const unassigned = (graph = buildGraph()) => graph.nodes.filter((n) => !contextOf(n));

/** The value imports `FORBIDDEN` rules out (`edytor/context-imports` lints the same). */
export const forbiddenEdges = (graph = buildGraph()) => {
	const out = [];
	for (const from of graph.nodes) {
		const banned = FORBIDDEN[contextOf(from)] ?? [];
		for (const to of graph.edges.get(from).keys()) {
			if (banned.includes(contextOf(to))) out.push(`${from} -> ${to}`);
		}
	}
	return out;
};

const main = () => {
	const args = process.argv.slice(2);
	const graph = buildGraph();
	const edgesAt = args.indexOf('--edges');
	if (edgesAt >= 0) {
		const target = args[edgesAt + 1];
		const out = [...(graph.edges.get(target)?.entries() ?? [])];
		const into = graph.nodes.filter((n) => graph.edges.get(n).has(target));
		console.log(`${target} (${contextOf(target)}) imports:`);
		for (const [t, how] of out)
			console.log(`  ${t} (${contextOf(t)})${how === 'dynamic' ? ' dynamic' : ''}`);
		console.log(`imported by:`);
		for (const n of into) console.log(`  ${n} (${contextOf(n)})`);
		return 0;
	}
	const betweenAt = args.indexOf('--between');
	if (betweenAt >= 0) {
		// Every value import from one context into another (`--between`
		// alone: every pair, grouped).
		const [from, to] = args.slice(betweenAt + 1, betweenAt + 3);
		const pairs = new Map();
		for (const n of graph.nodes) {
			if (from && contextOf(n) !== from) continue;
			for (const [t, how] of graph.edges.get(n)) {
				if (to ? contextOf(t) !== to : contextOf(t) === contextOf(n)) continue;
				const key = `${contextOf(n)} -> ${contextOf(t)}`;
				if (!pairs.has(key)) pairs.set(key, []);
				pairs.get(key).push(`${n} -> ${t}${how === 'dynamic' ? ' (dynamic)' : ''}`);
			}
		}
		for (const [key, list] of [...pairs].sort()) {
			console.log(`${key} (${list.length})`);
			for (const line of list) console.log(`  ${line}`);
		}
		return 0;
	}
	const all = cycles(graph);
	const crossing = all.filter((c) => c.contexts.length > 1);
	if (args.includes('--cross')) {
		// The edges inside each crossing cycle that leave their context, by
		// context pair: the imports to invert.
		for (const c of crossing) {
			const members = new Set(c.members);
			const pairs = new Map();
			for (const m of c.members) {
				for (const [t, how] of graph.edges.get(m)) {
					if (!members.has(t) || contextOf(m) === contextOf(t)) continue;
					const key = `${contextOf(m)} -> ${contextOf(t)}`;
					if (!pairs.has(key)) pairs.set(key, []);
					pairs.get(key).push(`${m} -> ${t}${how === 'dynamic' ? ' (dynamic)' : ''}`);
				}
			}
			for (const [key, list] of [...pairs].sort()) {
				console.log(key);
				for (const line of list) console.log(`  ${line}`);
			}
		}
		return crossing.length ? 1 : 0;
	}
	const missing = unassigned(graph);
	const banned = forbiddenEdges(graph);
	if (args.includes('--json')) {
		console.log(
			JSON.stringify({ cycles: all, crossing, unassigned: missing, forbidden: banned }, null, 2)
		);
	} else {
		const shown = args.includes('--all') ? all : crossing;
		for (const c of shown) {
			console.log(`${c.members.length} modules, contexts ${c.contexts.join(', ')}:`);
			for (const m of c.members) console.log(`  ${contextOf(m) ?? '?'}\t${m}`);
		}
		for (const m of missing) console.log(`no context: ${m}`);
		for (const edge of banned) console.log(`forbidden: ${edge}`);
		console.log(
			`${graph.nodes.length} modules, ${all.length} cycles, ${crossing.length} across contexts, ` +
				`${missing.length} unassigned, ${banned.length} forbidden imports`
		);
	}
	return crossing.length || missing.length || banned.length ? 1 : 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main();
}
