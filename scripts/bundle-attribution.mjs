// The minified bytes of a bundle-size probe, attributed to their source
// declarations (docs/agents/bundle-trim.md, "Attribution by function"):
// every emitted byte to its source position through the probe's source
// map, then to the declaration around it in the packaged `dist/` file — a
// top-level function, class or constant, and down to `--depth` levels
// inside (methods, class fields, an object's properties, a function's own
// declarations). A `.svelte` source is split into its `<script module>`,
// its `<script>` (each with its declarations), its top-level snippets and
// the rest, `(template)`.
//
//   node scripts/bundle-size.mjs --only minimal         # build the probe first
//   pnpm bundle:attribution                             # every edytor source, largest first
//   pnpm bundle:attribution crdt/doc/ session/ --top 40
//   pnpm bundle:attribution --files                     # one row per file
//   pnpm bundle:attribution --depth 2 --min 50 edytor.svelte.js
//   pnpm bundle:attribution --against <other cache> crdt/   # the change, per declaration
//
// Each row: minified bytes, the gzip share (the row's code gzipped alone,
// scaled so the bundle's sources sum to the bundle's gzip -9: an estimate,
// since gzip shares strings across rows), and `file › declaration › …`.
// A row counts the rows nested under it.
//
// `--app` picks the probe (default `minimal`), `--cache` the probes' cache
// directory (default `node_modules/.cache/bundle-size`, an exported copy's
// own when measuring it), `--against` a second cache to diff with (its
// bytes before, this cache's after), `--min` hides rows under that many
// bytes (default 30), `--top` keeps the largest rows, `--sort name` lists
// in source order instead of by size, `--json` writes every row. The
// positional arguments filter sources by substring.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const store = join(root, 'node_modules/.pnpm');
// Dependencies of the Svelte toolchain, not of edytor: found in the pnpm store.
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
const { parse: parseSvelte } = await import('svelte/compiler');

const args = process.argv.slice(2);
const flag = (name) => {
	const at = args.indexOf(name);
	if (at >= 0) args.splice(at, 1);
	return at >= 0;
};
const option = (name, fallback) => {
	const at = args.indexOf(name);
	if (at < 0) return fallback;
	const [value] = args.splice(at, 2).slice(1);
	return value;
};
const app = option('--app', 'minimal');
const depth = Number(option('--depth', 1));
const min = Number(option('--min', 30));
const top = Number(option('--top', Infinity));
const sort = option('--sort', 'size');
const json = option('--json', null);
const cache = option('--cache', join(root, 'node_modules/.cache/bundle-size'));
const against = option('--against', null);
const filesOnly = flag('--files');
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
	if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression')
		return `${node.expression.callee.name ?? '(call)'}(…)`;
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
		case 'Program':
			return node.body;
		default:
			return [];
	}
};

/**
 * The units of one `dist/` source, top level first: `{ name, start, end,
 * kids }` in source offsets. A `.svelte` file's are its scripts, its
 * top-level snippets and `(template)`, which takes what the others leave.
 */
const unitsOf = (text, file) => {
	const declarations = (nodes) =>
		nodes.map((node) => ({
			name: nameOf(node),
			start: node.start,
			end: node.end,
			kids: () => declarations(inner(node))
		}));
	if (file.endsWith('.js'))
		return declarations(acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' }).body);
	if (!file.endsWith('.svelte')) return [];
	const ast = parseSvelte(text, { modern: true });
	const script = (tag, program) =>
		program && {
			name: tag,
			start: program.start,
			end: program.end,
			kids: () => declarations(program.body)
		};
	return [
		script('<script module>', ast.module?.content),
		script('<script>', ast.instance?.content),
		...ast.fragment.nodes
			.filter((node) => node.type === 'SnippetBlock')
			.map((node) => ({
				name: `{#snippet ${node.expression.name}}`,
				start: node.start,
				end: node.end,
				kids: () => []
			})),
		{ name: '(template)', start: 0, end: text.length, rest: true, kids: () => [] }
	].filter(Boolean);
};

/** `file › declaration › …` → `{ min, code }`, for the sources `wanted` names. */
const attribute = (dir) => {
	const assets = join(dir, app, 'out/assets');
	/** Every mapped source's generated pieces: `[offset in source, bytes, code]`. */
	const pieces = new Map();
	let gzip = 0;
	for (const file of readdirSync(assets).filter((f) => f.endsWith('.js'))) {
		const code = readFileSync(join(assets, file), 'utf8');
		gzip += gzipSync(code, { level: 9 }).length;
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
			const line = lines[at.generatedLine - 1] ?? '';
			const length = Math.max(
				0,
				next && next.generatedLine === at.generatedLine
					? next.generatedColumn - at.generatedColumn
					: line.length - at.generatedColumn
			);
			const source = join(assets, at.source).replace(/\\/g, '/');
			if (!pieces.has(source)) pieces.set(source, []);
			pieces
				.get(source)
				.push([
					at.originalLine,
					at.originalColumn,
					length,
					line.substr(at.generatedColumn, length)
				]);
		}
	}
	// The gzip share's scale: every source's code gzipped alone sums to the bundle's gzip.
	let alone = 0;
	for (const list of pieces.values())
		alone += gzipSync(list.map((p) => p[3]).join(''), { level: 9 }).length;
	const scale = gzip / alone;
	const out = new Map();
	const add = (key, list) => {
		if (list.length === 0) return;
		const code = list.map((p) => p[3]).join('');
		out.set(key, {
			min: list.reduce((sum, p) => sum + p[2], 0),
			gzip: Math.round(gzipSync(code, { level: 9 }).length * scale)
		});
	};
	for (const [source, list] of pieces) {
		if (!/\/dist\//.test(source) || (wanted.length && !wanted.some((w) => source.includes(w))))
			continue;
		const file = source.replace(/.*\/dist\//, '');
		add(file, list);
		if (filesOnly) continue;
		const text = readFileSync(source, 'utf8');
		const lineStarts = [0];
		for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
		const placed = list.map((p) => [(lineStarts[p[0] - 1] ?? 0) + p[1], ...p.slice(2)]);
		const walk = (units, within, path, level) => {
			const seen = new Map();
			const claimed = new Set();
			for (const unit of [...units].sort((a, b) => Number(a.rest ?? 0) - Number(b.rest ?? 0))) {
				const mine = within.filter((p) => !claimed.has(p) && p[0] >= unit.start && p[0] < unit.end);
				for (const p of mine) claimed.add(p);
				const n = (seen.get(unit.name) ?? 0) + 1;
				seen.set(unit.name, n);
				const key = `${path} › ${unit.name}${n > 1 ? `#${n}` : ''}`;
				add(
					key,
					mine.map((p) => [0, 0, p[1], p[2]])
				);
				if (level < depth && mine.length) walk(unit.kids(), mine, key, level + 1);
			}
		};
		walk(unitsOf(text, file), placed, file, 0);
	}
	return out;
};

const after = attribute(cache);
const before = against ? attribute(against) : null;
const rows = [...new Set([...after.keys(), ...(before?.keys() ?? [])])]
	.map((key) => ({
		key,
		before: before ? (before.get(key)?.min ?? 0) : undefined,
		min: after.get(key)?.min ?? 0,
		gzip: after.get(key)?.gzip ?? 0
	}))
	.filter((row) => Math.abs(before ? row.min - row.before : row.min) >= min)
	.sort((x, y) =>
		sort === 'name'
			? x.key.localeCompare(y.key)
			: before
				? Math.abs(y.min - y.before) - Math.abs(x.min - x.before)
				: y.min - x.min
	)
	.slice(0, top);
for (const row of rows)
	console.log(
		before
			? `${String(row.min - row.before).padStart(7)}  ${String(row.before).padStart(6)} → ${String(row.min).padStart(6)}  ${row.key}`
			: `${String(row.min).padStart(7)} ${String(row.gzip).padStart(6)}gz  ${row.key}`
	);
if (json) writeFileSync(json, JSON.stringify(rows, null, '\t'));
