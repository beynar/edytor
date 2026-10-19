// The minified bytes of a bundle-size probe, attributed to their source
// declarations (docs/agents/bundle-trim.md, "Attribution by function"):
// every emitted byte to its source position through the probe's source
// map, then to the declaration around it in the packaged `dist/` file — a
// top-level function, class or constant, and down to `--depth` levels
// inside (methods, class fields, an object's properties, a function's own
// declarations). A `.svelte` source is reported as a whole.
//
//   node scripts/bundle-size.mjs --only minimal         # build the probe first
//   node scripts/bundle-attribution.mjs crdt/doc/suggest.js session/
//   node scripts/bundle-attribution.mjs --depth 2 --min 50 edytor.svelte.js
//   node scripts/bundle-attribution.mjs --against <other cache> crdt/   # the change, per declaration
//
// `--app` picks the probe (default `minimal`), `--cache` the probes' cache
// directory (default `node_modules/.cache/bundle-size`, an exported copy's
// own when measuring it), `--against` a second cache to diff with (its
// bytes before, this cache's after). Without a file filter, every edytor
// source is listed.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const store = join(root, 'node_modules/.pnpm');
const fromStore = (name, path) =>
	require(
		join(
			store,
			readdirSync(store).find((entry) => entry.startsWith(name)),
			path
		)
	);
const { SourceMapConsumer } = fromStore('source-map-js@', 'node_modules/source-map-js');
const acorn = fromStore('acorn@8', 'node_modules/acorn');

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(name);
	if (at < 0) return fallback;
	const [value] = args.splice(at, 2).slice(1);
	return value;
};
const app = option('--app', 'minimal');
const depth = Number(option('--depth', 1));
const min = Number(option('--min', 30));
const cache = option('--cache', join(root, 'node_modules/.cache/bundle-size'));
const against = option('--against', null);
const wanted = args;

/** A declaration's name in the report. */
const nameOf = (node) => {
	if (node.type === 'ExportNamedDeclaration' && node.declaration) return nameOf(node.declaration);
	if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return node.id?.name;
	if (node.type === 'VariableDeclaration')
		return node.declarations.map((d) => d.id.name ?? '{…}').join(',');
	if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
		const key =
			(node.key.type === 'PrivateIdentifier' ? '#' : '') + (node.key.name ?? node.key.value);
		return node.kind === 'get' || node.kind === 'set' ? `${key} (${node.kind})` : key;
	}
	if (node.type === 'Property') return node.key?.name ?? node.key?.value ?? '?';
	return node.type;
};
/** The declarations inside `node` the report descends into. */
const inner = (node) => {
	if (!node) return [];
	switch (node.type) {
		case 'ExportNamedDeclaration':
			return inner(node.declaration);
		case 'ClassDeclaration':
		case 'ClassExpression':
			return node.body.body;
		case 'FunctionDeclaration':
		case 'FunctionExpression':
		case 'ArrowFunctionExpression':
			return node.body.type === 'BlockStatement'
				? node.body.body.filter((s) =>
						['VariableDeclaration', 'FunctionDeclaration', 'ReturnStatement'].includes(s.type)
					)
				: inner(node.body);
		case 'VariableDeclaration':
			return node.declarations.length === 1 ? inner(node.declarations[0].init) : [];
		case 'MethodDefinition':
		case 'PropertyDefinition':
		case 'Property':
			return inner(node.value);
		case 'ObjectExpression':
			return node.properties;
		case 'ReturnStatement':
			return inner(node.argument);
		default:
			return [];
	}
};

/** `path › declaration › …` → minified bytes, for the sources `wanted` names. */
const attribute = (dir) => {
	const assets = join(dir, app, 'out/assets');
	const positions = new Map();
	for (const file of readdirSync(assets).filter((f) => f.endsWith('.js'))) {
		const code = readFileSync(join(assets, file), 'utf8');
		const lines = code.split('\n');
		const map = new SourceMapConsumer(
			JSON.parse(readFileSync(join(assets, `${file}.map`), 'utf8'))
		);
		const segments = [];
		map.eachMapping((m) => segments.push(m), null, SourceMapConsumer.GENERATED_ORDER);
		for (let i = 0; i < segments.length; i++) {
			const at = segments[i];
			const next = segments[i + 1];
			if (!at.source) continue;
			const length =
				next && next.generatedLine === at.generatedLine
					? next.generatedColumn - at.generatedColumn
					: (lines[at.generatedLine - 1]?.length ?? 0) - at.generatedColumn;
			const source = join(assets, at.source).replace(/\\/g, '/');
			if (!/\/dist\//.test(source) || (wanted.length && !wanted.some((w) => source.includes(w))))
				continue;
			if (!positions.has(source)) positions.set(source, []);
			positions.get(source).push([at.originalLine, at.originalColumn, Math.max(0, length)]);
		}
	}
	const out = new Map();
	for (const [source, bytes] of positions) {
		const file = source.replace(/.*\/dist\//, '');
		out.set(
			file,
			bytes.reduce((sum, b) => sum + b[2], 0)
		);
		if (!file.endsWith('.js')) continue;
		const ast = acorn.parse(readFileSync(source, 'utf8'), {
			ecmaVersion: 'latest',
			sourceType: 'module',
			locations: true
		});
		const within = ({ loc: { start, end } }) => {
			let sum = 0;
			for (const [line, column, size] of bytes)
				if (
					(line > start.line || (line === start.line && column >= start.column)) &&
					(line < end.line || (line === end.line && column < end.column))
				)
					sum += size;
			return sum;
		};
		const walk = (nodes, path, level) => {
			const seen = new Map();
			for (const node of nodes) {
				let name = nameOf(node);
				const n = (seen.get(name) ?? 0) + 1;
				seen.set(name, n);
				if (n > 1) name += `#${n}`;
				const key = `${path} › ${name}`;
				out.set(key, (out.get(key) ?? 0) + within(node));
				if (level < depth) walk(inner(node), key, level + 1);
			}
		};
		walk(ast.body, file, 0);
	}
	return out;
};

const after = attribute(cache);
const before = against ? attribute(against) : null;
const rows = [...new Set([...after.keys(), ...(before?.keys() ?? [])])]
	.map((key) => [key, before?.get(key) ?? 0, after.get(key) ?? 0])
	.filter(([, b, a]) => Math.abs(before ? a - b : a) >= min)
	.sort(([x], [y]) => x.localeCompare(y));
for (const [key, b, a] of rows)
	console.log(
		before
			? `${String(a - b).padStart(7)}  ${String(b).padStart(6)} → ${String(a).padStart(6)}  ${key}`
			: `${String(a).padStart(7)}  ${key}`
	);
