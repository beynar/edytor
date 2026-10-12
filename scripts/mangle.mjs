#!/usr/bin/env node
/**
 * Shortens the package's internal property names (`pnpm package`, after
 * `svelte-package`): `dist/**\/*.js` only, never a declaration or a Svelte
 * component.
 *
 *   node scripts/mangle.mjs            # rewrite dist/ (the names of scripts/mangle-names.txt)
 *   node scripts/mangle.mjs --write    # rewrite scripts/mangle-names.txt from the rules below (review its diff)
 *   node scripts/mangle.mjs --check    # fail unless every listed name passes the rules (no write)
 *
 * The set is explicit: `scripts/mangle-names.txt`, reviewed like the API
 * report. Each listed name must still pass the rules when the package is
 * built, or the build fails naming it (a name that became public, reached a
 * component or a string is never shortened silently).
 *
 * A name is a candidate when the package's own JavaScript
 *  - declares it as a class member (method, field, accessor) and never as an
 *    object key; or
 *  - declares it as an object key or assigns it, reads it by name (`x.name`),
 *    and no module of the sync context (`cloudflare/`, `collaboration/`,
 *    `crdt/providers`, `crdt/protocols`, `crdt/migration`) nor any module that
 *    serializes (JSON, structured clone, messages, storage) names it: wire and
 *    stored keys keep their names.
 * and none of these names it (each read as identifiers and the words of
 * strings, comments left out):
 *  - the platform: TypeScript's lib declarations;
 *  - the public surface: every declaration file a consumer's types reach
 *    from the package's entry points (members stripped as `@internal` are
 *    not in them);
 *  - a Svelte component of the package (compiled by the consumer, its
 *    templates read members by name);
 *  - a dependency's code or declarations, or a library loaded at run time
 *    (KaTeX, the Workers runtime);
 *  - a string, template or regular expression of the package's JavaScript
 *    (a member looked up by a computed key keeps its name), `dataset` keys,
 *    a module's export and import names (a namespace import reads them as
 *    members);
 *  - a property or method signature of a type in `src/lib` (data shapes,
 *    options, ports);
 *  - the site's, the demo chrome's (the site's live editor draws it) and the
 *    packed consumer's own code (the docs' examples are type-checked against
 *    the public surface).
 * Names of two characters or fewer are left alone.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(ROOT, 'package.json'));
const ts = require('typescript');
const WRITE = process.argv.includes('--write');
const CHECK = process.argv.includes('--check');
const LIST = join(ROOT, 'scripts/mangle-names.txt');
const DIST = join(ROOT, 'dist');

/** Project folders skip their builds; a dependency's are its code. */
const BUILDS = /^(node_modules|\.svelte-kit|test-results|dist[^/]*)$/;
const files = (dir, re, skip = BUILDS, out = []) => {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (skip.test(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) files(path, re, skip, out);
		else if (re.test(path)) out.push(path);
	}
	return out;
};
const read = (path) => readFileSync(path, 'utf8');

// ── Reserved names ──────────────────────────────────────────────────────
const reserved = new Set();
const WORD = /[A-Za-z_$][\w$]*/g;
const words = (text) => {
	for (const word of text.match(WORD) ?? []) reserved.add(word);
};
const STRINGISH = new Set([
	ts.SyntaxKind.StringLiteral,
	ts.SyntaxKind.NoSubstitutionTemplateLiteral,
	ts.SyntaxKind.TemplateHead,
	ts.SyntaxKind.TemplateMiddle,
	ts.SyntaxKind.TemplateTail,
	ts.SyntaxKind.RegularExpressionLiteral
]);
/** The identifiers of a script or declaration file and the words of its strings, never its comments. */
const code = (path) => {
	const kind = /\.d\.ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
	const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, kind);
	const visit = (node) => {
		if (ts.isIdentifier(node)) reserved.add(node.text);
		else if (STRINGISH.has(node.kind)) words(node.getText(ast));
		ts.forEachChild(node, visit);
	};
	visit(ast);
};

// The platform.
for (const path of files(join(ROOT, 'node_modules/typescript/lib'), /\/lib\.[^/]*\.d\.ts$/))
	code(path);
// The public surface: every declaration file a consumer's types reach from
// the package's entry points (`exports`), following `from` and `import()`.
const pkg = JSON.parse(read(join(ROOT, 'package.json')));
const reached = new Set();
const pending = Object.values(pkg.exports)
	.filter((target) => typeof target === 'object' && target.types)
	.map((target) => join(ROOT, target.types));
const declarationOf = (from, spec) => {
	if (!spec.startsWith('.')) return null;
	const base = resolve(dirname(from), spec);
	return (
		[base.replace(/\.js$/, '.d.ts'), `${base}.d.ts`, join(base, 'index.d.ts'), base].find(
			(path) => path.endsWith('.d.ts') && existsSync(path)
		) ?? null
	);
};
while (pending.length > 0) {
	const path = pending.pop();
	if (reached.has(path)) continue;
	reached.add(path);
	code(path);
	for (const [, spec] of read(path).matchAll(/(?:\bfrom\s+|\bimport\(\s*)['"]([^'"]+)['"]/g)) {
		const next = declarationOf(path, spec);
		if (next) pending.push(next);
	}
}
// The package's components.
for (const path of files(DIST, /\.svelte$/)) words(read(path));
// Dependencies: every package the build imports, and the libraries met at run time.
const modules = files(DIST, /\.js$/).map((path) => {
	const text = read(path);
	return {
		path,
		text,
		ast: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
	};
});
const dependencies = new Set(['@cloudflare/workers-types', 'katex', 'svelte']);
for (const { ast } of modules)
	for (const statement of ast.statements)
		if (
			(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
			statement.moduleSpecifier &&
			ts.isStringLiteral(statement.moduleSpecifier)
		) {
			const spec = statement.moduleSpecifier.text;
			if (spec.startsWith('.') || spec.startsWith('edytor') || spec.includes(':')) continue;
			dependencies.add(
				spec
					.split('/')
					.slice(0, spec.startsWith('@') ? 2 : 1)
					.join('/')
			);
		}
for (const name of dependencies)
	for (const path of files(
		join(ROOT, 'node_modules', name),
		/\.(d\.ts|js|mjs|cjs)$/,
		/^node_modules$/
	))
		code(path);
// The types of src/lib: data shapes, options and ports.
for (const path of files(join(ROOT, 'src/lib'), /\.ts$/)) {
	if (path.includes('/vendor/')) continue;
	const visit = (node) => {
		if (
			(ts.isPropertySignature(node) || ts.isMethodSignature(node)) &&
			node.name &&
			(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
		)
			reserved.add(node.name.text);
		ts.forEachChild(node, visit);
	};
	visit(ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, false));
}
// The site's and the packed consumer's code.
for (const dir of [
	'site/islands',
	'site/pages',
	'site/room',
	'src/routes/chrome',
	'tests/packed-consumer'
])
	for (const path of files(join(ROOT, dir), /\.(ts|js|mjs|svelte|mdx)$/)) words(read(path));

// ── The package's property names ─────────────────────────────────────────
const SYNC = /\/dist\/(cloudflare|collaboration|crdt\/(providers|protocols|migration))\//;
const SERIALIZES =
	/JSON\.stringify|structuredClone|postMessage|serializeAttachment|\.storage\b|localStorage|sessionStorage|indexedDB|BroadcastChannel/;
const sites = [];
const classMember = new Set();
const objectKey = new Set();
const assigned = new Set();
const readByName = new Set();
const wireNamed = new Set();
const isClass = (node) => node && (ts.isClassDeclaration(node) || ts.isClassExpression(node));
for (const module of modules) {
	const wire = SYNC.test(module.path) || SERIALIZES.test(module.text);
	const visit = (node) => {
		const parent = node.parent;
		if (STRINGISH.has(node.kind)) words(node.getText(module.ast));
		if (wire && ts.isIdentifier(node)) wireNamed.add(node.text);
		// A module's export and import names: a namespace import reads them as members.
		if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
			reserved.add(node.name.text);
			if (node.propertyName) reserved.add(node.propertyName.text);
		}
		if (
			(ts.isFunctionDeclaration(node) ||
				ts.isClassDeclaration(node) ||
				ts.isVariableStatement(node)) &&
			node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
		) {
			if (ts.isVariableStatement(node))
				for (const d of node.declarationList.declarations) {
					if (ts.isIdentifier(d.name)) reserved.add(d.name.text);
				}
			else if (node.name) reserved.add(node.name.text);
		}
		const site = (name, shape = 'name') =>
			sites.push({
				module,
				start: name.getStart(module.ast),
				end: name.end,
				name: name.text,
				shape
			});
		if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
			site(node.name);
			const target =
				ts.isBinaryExpression(parent) &&
				parent.left === node &&
				parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
				parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
			if (target) assigned.add(node.name.text);
			else readByName.add(node.name.text);
			if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'dataset')
				reserved.add(node.name.text);
		} else if (
			(ts.isMethodDeclaration(node) ||
				ts.isPropertyDeclaration(node) ||
				ts.isGetAccessorDeclaration(node) ||
				ts.isSetAccessorDeclaration(node) ||
				ts.isPropertyAssignment(node)) &&
			ts.isIdentifier(node.name)
		) {
			site(node.name);
			(isClass(parent) ? classMember : objectKey).add(node.name.text);
		} else if (ts.isShorthandPropertyAssignment(node)) {
			site(node.name, 'shorthand');
			objectKey.add(node.name.text);
		} else if (
			ts.isBindingElement(node) &&
			ts.isObjectBindingPattern(parent) &&
			!node.dotDotDotToken
		) {
			if (node.propertyName && ts.isIdentifier(node.propertyName)) site(node.propertyName);
			else if (!node.propertyName && ts.isIdentifier(node.name)) site(node.name, 'shorthand');
		}
		ts.forEachChild(node, visit);
	};
	visit(module.ast);
}

/** Why a name may not be shortened, or `null`. */
const refusal = (name) => {
	if (name.length <= 2) return 'two characters or fewer';
	if (reserved.has(name))
		return 'reserved (platform, public surface, component, dependency, string or type)';
	if (classMember.has(name) && !objectKey.has(name)) return null;
	if (!objectKey.has(name) && !assigned.has(name)) return 'not declared by the package';
	if (!readByName.has(name)) return 'never read by name';
	if (wireNamed.has(name)) return 'named by a sync or serializing module';
	return null;
};
const counts = new Map();
for (const { name } of sites) counts.set(name, (counts.get(name) ?? 0) + 1);
const allowed = [...counts.keys()].filter((name) => refusal(name) === null).sort();

if (WRITE) {
	const header = read(LIST)
		.split('\n')
		.filter((line) => line.startsWith('#'))
		.join('\n');
	writeFileSync(LIST, `${header}\n${allowed.join('\n')}\n`);
	console.log(`mangle: ${allowed.length} names written to ${relative(ROOT, LIST)}`);
	process.exit(0);
}
const listed = read(LIST)
	.split('\n')
	.map((line) => line.trim())
	.filter((line) => line && !line.startsWith('#'));
const refused = listed
	.map((name) => [name, counts.has(name) ? refusal(name) : 'not in the package'])
	.filter(([, why]) => why !== null);
if (refused.length > 0) {
	for (const [name, why] of refused) console.error(`mangle: ${name} cannot be shortened: ${why}`);
	console.error(
		'mangle: remove these names from scripts/mangle-names.txt (node scripts/mangle.mjs --write)'
	);
	process.exit(1);
}
if (CHECK) {
	console.log(`mangle: ${listed.length} listed names pass`);
	process.exit(0);
}

// ── Short names: most bytes first, none a name anything else uses ─────────
const taken = new Set([...reserved, ...counts.keys()]);
const FIRST = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
const NEXT = `${FIRST}0123456789`;
function* shortNames() {
	for (const a of FIRST) yield a;
	for (const a of FIRST) for (const b of NEXT) yield a + b;
	for (const a of FIRST) for (const b of NEXT) for (const c of NEXT) yield a + b + c;
}
const fresh = shortNames();
const order = listed.sort(
	(a, b) => counts.get(b) * b.length - counts.get(a) * a.length || (a < b ? -1 : 1)
);
const renamed = new Map();
for (const name of order) {
	let short;
	do short = fresh.next().value;
	while (taken.has(short));
	renamed.set(name, short);
}

const edits = new Map();
for (const { module, start, end, name, shape } of sites) {
	const short = renamed.get(name);
	if (short === undefined) continue;
	const list = edits.get(module) ?? [];
	list.push(
		shape === 'shorthand' ? { start, end: start, text: `${short}: ` } : { start, end, text: short }
	);
	edits.set(module, list);
}
let saved = 0;
for (const [module, list] of edits) {
	let text = module.text;
	for (const { start, end, text: insert } of list.sort((a, b) => b.start - a.start))
		text = text.slice(0, start) + insert + text.slice(end);
	saved += module.text.length - text.length;
	writeFileSync(module.path, text);
}
console.log(
	`mangle: ${renamed.size} names shortened in ${edits.size} modules (${(saved / 1024).toFixed(1)} KB of source)`
);
