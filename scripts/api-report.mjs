#!/usr/bin/env node
/**
 * The API surface report (`pnpm api:report`, `pnpm check:api`).
 *
 * Builds the package's declarations the way `pnpm package` does
 * (`svelte-package`, into `node_modules/.cache/edytor-api`, never `dist/`),
 * then writes one report per entry point of `package.json` `exports` into
 * `api/`:
 *
 * - every exported name, sorted, under a `### name` heading, with its
 *   emitted declaration (comments removed: the report tracks shapes, not
 *   prose);
 * - the declarations the exported ones reach without exporting them
 *   ("Reachable, not exported"): a type a consumer meets through a member
 *   (`edytor.dispatcher`'s `Dispatcher`), which changes the surface too.
 *
 * The raw engine (`edytor/crdt`, the vendored fork) is reported by name
 * only: its declarations are upstream's.
 *
 * The JSDoc of every reported declaration (exported or reachable) is what
 * a consumer's editor shows: it names no internal ticket code (`R4`,
 * `UW-22`, `DR-props-2`, …), which this script also checks (`CODE`, both
 * modes).
 *
 * `--check` regenerates in memory and fails when a report differs from the
 * committed one, or when the emitted declarations of an entry do not
 * compile under `strict` with `skipLibCheck: false` (what a consumer's
 * `tsc` sees: a member stripped as `@internal` that another declaration
 * still names fails here). `src/tests/api/public-surface.test.ts` runs it,
 * so an unreviewed change to the surface fails the unit lane.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildPackage, ROOT } from './package-declarations.mjs';

const require = createRequire(path.join(ROOT, 'package.json'));
const ts = require('typescript');
const CHECK = process.argv.includes('--check');
const OUT = path.join(ROOT, 'node_modules/.cache/edytor-api/dist');
const REPORTS = path.join(ROOT, 'api');

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
/** `edytor/crdt` is the vendored engine: names only. */
const NAMES_ONLY = new Set(['./crdt']);

const build = () => buildPackage(OUT);

/** `edytor/crdt/edytor` → `edytor-crdt-edytor` (the report's file name). */
const reportName = (subpath) =>
	subpath === '.' ? 'edytor' : `edytor-${subpath.slice(2).replaceAll('/', '-')}`;

const entries = () =>
	Object.entries(pkg.exports)
		.filter(([, target]) => typeof target === 'object' && target.types)
		.map(([subpath, target]) => ({
			subpath,
			name: reportName(subpath),
			file: path.join(OUT, target.types.replace(/^\.\/dist\//, ''))
		}));

/**
 * An internal ticket code in prose: letters then digits (`R4`, `O45`, `P11`,
 * `SW16`, `U6b`), letters, a dash and digits (`D-8`, `UW-22`, `FX-01`), a
 * review row (`DR-props-2`), or a plan section (`§2.4`). `UTF-16` and
 * `ES2022` are not codes, nor are the Cloudflare products where the prose
 * names them as such (`R2 bucket`, `R2 binding`, `D1 database`, …): a bare
 * `R2` or `D1` is a ticket code.
 */
const CODE =
	/\b(?!UTF-|ES20|R2[\s*]+(?:bucket|binding|custom|takes|expires|lifecycle)\b|D1[\s*]+(?:database|binding)\b)(?:[A-Z]{1,3}\d{1,3}[a-z]?|[A-Z]{1,3}-\d{1,3}[a-z]?|[A-Z]{2}\d?-[a-z]+-\d+)\b|§\s?\d+(?:\.\d+)*/g;
/** JSDoc blocks of the reported declarations that name a ticket code: `file:line → codes`. */
const coded = new Map();
/** Record the ticket codes of every JSDoc block in `node` (its own and its members'). */
const scanCodes = (node) => {
	const sf = node.getSourceFile();
	const visit = (child) => {
		for (const range of ts.getLeadingCommentRanges(sf.text, child.pos) ?? []) {
			const text = sf.text.slice(range.pos, range.end);
			const codes = text.startsWith('/**') ? text.match(CODE) : null;
			if (!codes) continue;
			const { line } = sf.getLineAndCharacterOfPosition(range.pos);
			coded.set(`${path.relative(OUT, sf.fileName)}:${line + 1}`, [...new Set(codes)]);
		}
		ts.forEachChild(child, visit);
	};
	visit(ts.isVariableDeclaration(node) ? node.parent.parent : node);
};

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** The printed declaration of one declaration node (a variable with its statement keyword). */
const print = (node) => {
	const sf = node.getSourceFile();
	if (ts.isVariableDeclaration(node)) {
		const list = node.parent;
		const keyword =
			list.flags & ts.NodeFlags.Const ? 'const' : list.flags & ts.NodeFlags.Let ? 'let' : 'var';
		return `declare ${keyword} ${printer.printNode(ts.EmitHint.Unspecified, node, sf)};`;
	}
	return printer.printNode(ts.EmitHint.Unspecified, node, sf);
};

const VENDOR = path.join(OUT, 'crdt/vendor') + path.sep;
/** Declared by the package itself (the vendored engine's declarations are upstream's). */
const inPackage = (node) => {
	const file = path.resolve(node.getSourceFile().fileName);
	return file.startsWith(OUT + path.sep) && !file.startsWith(VENDOR);
};
const relative = (node) =>
	path.relative(OUT, node.getSourceFile().fileName).split(path.sep).join('/');

const report = (program, entry) => {
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(entry.file);
	if (!source) throw new Error(`api-report: ${entry.file} was not emitted`);
	const moduleSymbol = checker.getSymbolAtLocation(source);
	const exported = checker
		.getExportsOfModule(moduleSymbol)
		.map((symbol) => ({
			name: symbol.name,
			target: symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
		}))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const lines = [
		`# API report: \`${entry.subpath === '.' ? 'edytor' : `edytor/${entry.subpath.slice(2)}`}\``,
		'',
		'Generated by `scripts/api-report.mjs` (`pnpm api:report`) from the emitted declarations.',
		'Review every change to this file: it is the public surface of the entry point.',
		'',
		`${exported.length} exported names.`,
		''
	];
	if (NAMES_ONLY.has(entry.subpath)) {
		lines.push('The vendored engine: names only.', '');
		for (const { name } of exported) lines.push(`- ${name}`);
		return lines.join('\n') + '\n';
	}
	const seen = new Set(exported.map(({ target }) => target));
	const reachable = new Map();
	/** Record the package-own declarations a node's type references name. */
	const collect = (node) => {
		const visit = (child) => {
			if (
				ts.isTypeReferenceNode(child) ||
				ts.isExpressionWithTypeArguments(child) ||
				ts.isTypeQueryNode(child)
			) {
				const at = ts.isTypeReferenceNode(child)
					? child.typeName
					: ts.isTypeQueryNode(child)
						? child.exprName
						: child.expression;
				let symbol = checker.getSymbolAtLocation(at);
				if (symbol && symbol.flags & ts.SymbolFlags.Alias)
					symbol = checker.getAliasedSymbol(symbol);
				if (
					symbol &&
					!(symbol.flags & ts.SymbolFlags.TypeParameter) &&
					!seen.has(symbol) &&
					symbol.declarations?.some(inPackage)
				) {
					seen.add(symbol);
					reachable.set(symbol, symbol);
				}
			}
			ts.forEachChild(child, visit);
		};
		visit(node);
	};
	for (const { name, target } of exported) {
		const declarations = (target.declarations ?? []).filter(inPackage);
		lines.push(`### ${name}`, '');
		if (!declarations.length) {
			lines.push('(declared outside the package)', '');
			continue;
		}
		lines.push('```ts');
		for (const declaration of declarations) {
			lines.push(`// ${relative(declaration)}`, print(declaration));
			collect(declaration);
			scanCodes(declaration);
		}
		lines.push('```', '');
	}
	// The closure of what the exported declarations reach.
	const queue = [...reachable.values()];
	const reached = [];
	while (queue.length) {
		const symbol = queue.shift();
		reached.push(symbol);
		const before = reachable.size;
		for (const declaration of (symbol.declarations ?? []).filter(inPackage)) {
			collect(declaration);
			scanCodes(declaration);
		}
		queue.push(...[...reachable.values()].slice(before));
	}
	if (reached.length) {
		lines.push('## Reachable, not exported', '');
		const keyed = reached
			.flatMap((symbol) =>
				(symbol.declarations ?? []).filter(inPackage).map((declaration) => ({
					key: `${relative(declaration)}#${symbol.name}`,
					declaration
				}))
			)
			.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		const done = new Set();
		for (const { key, declaration } of keyed) {
			if (done.has(key + print(declaration))) continue;
			done.add(key + print(declaration));
			lines.push(`#### ${key}`, '', '```ts', print(declaration), '```', '');
		}
	}
	return lines.join('\n');
};

// ── The site's API reference (`site/content/docs/reference/api/*.mdx`) ─────

const PAGES = path.join(ROOT, 'site/content/docs/reference/api');

/**
 * Text for MDX: a `{@link X}` (or `{@link X | label}`) as code, then `{`,
 * `}` and `<` escaped outside code spans.
 */
const mdx = (text) =>
	text
		.replace(/\{@link(?:code|plain)?\s+([^}|\s]+)\s*(?:\|\s*([^}]+))?\}/g, (_, target, label) =>
			label ? `${label.trim()} (\`${target}\`)` : `\`${target}\``
		)
		.split(/(`[^`]*`)/)
		.map((part, index) =>
			index % 2 ? part : part.replace(/[{}]/g, (c) => `\\${c}`).replace(/</g, '&lt;')
		)
		.join('');

/** A symbol's JSDoc as markdown: its text, then its `@deprecated` note. */
const docOf = (checker, symbol) => {
	const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
	const deprecated = symbol.getJsDocTags(checker).find((tag) => tag.name === 'deprecated');
	const note = deprecated
		? `**Deprecated.** ${ts.displayPartsToString(deprecated.text ?? []).trim()}`.trim()
		: '';
	return [text, note].filter(Boolean).map(mdx).join('\n\n');
};

/** The documented members of a class, an interface or an object type: `name`, then its first paragraph. */
const membersOf = (checker, node) => {
	let members = [];
	if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) members = node.members;
	else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type))
		members = node.type.members;
	const rows = [];
	for (const member of members) {
		if (!member.name || ts.isPrivateIdentifier(member.name)) continue;
		const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
		if (modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) continue;
		const symbol = member.symbol ?? checker.getSymbolAtLocation(member.name);
		if (!symbol) continue;
		// Its first sentence: the reference lists, the guides explain.
		const paragraph = docOf(checker, symbol).split('\n\n')[0].replace(/\n/g, ' ');
		const doc = /^[\s\S]*?[.!?](?=\s|$)/.exec(paragraph)?.[0] ?? paragraph;
		if (doc) rows.push(`- \`${member.name.getText()}\`: ${doc}`);
	}
	return rows;
};

const page = (program, entry) => {
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(entry.file);
	const moduleSymbol = checker.getSymbolAtLocation(source);
	const specifier = entry.subpath === '.' ? 'edytor' : `edytor/${entry.subpath.slice(2)}`;
	const exported = checker
		.getExportsOfModule(moduleSymbol)
		.map((symbol) => ({
			name: symbol.name,
			target: symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
		}))
		.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
	const lines = [
		'---',
		`title: "${specifier}"`,
		`description: "Every name ${specifier} exports, with its declaration and documentation (generated from the published types)."`,
		'---',
		'',
		`{/* Generated by scripts/api-report.mjs (pnpm api:report) from the published declarations: edit the JSDoc, not this page. */}`,
		'',
		`Every name \`${specifier}\` exports, generated from the package's published type declarations, with the documentation its JSDoc carries. The guides explain how the pieces fit; this page is the exhaustive list. ${exported.length} names.`,
		''
	];
	for (const { name, target } of exported) {
		const declarations = (target.declarations ?? []).filter(inPackage);
		lines.push(`## ${name}`, '');
		const doc = docOf(checker, target);
		if (doc) lines.push(doc, '');
		if (!declarations.length) continue;
		lines.push('```ts');
		for (const declaration of declarations) lines.push(print(declaration));
		lines.push('```', '');
		const members = declarations.flatMap((declaration) => membersOf(checker, declaration));
		if (members.length) lines.push(...members, '');
	}
	return lines.join('\n');
};

/** The emitted declarations of every entry compile as a strict consumer reads them. */
const diagnostics = (program) =>
	ts
		.getPreEmitDiagnostics(program)
		.filter((d) => !d.file || path.resolve(d.file.fileName).startsWith(OUT + path.sep))
		.map((d) => {
			const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
			if (!d.file) return message;
			const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
			return `${path.relative(OUT, d.file.fileName)}:${line + 1}:${character + 1} ${message}`;
		});

build();
const list = entries();
/** `edytor/cloudflare` runs in a Worker: its declarations read the Workers runtime's globals. */
const WORKER = new Set(['./cloudflare']);
const programOf = (group, worker) =>
	ts.createProgram(
		group.map((entry) => entry.file),
		{
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			target: ts.ScriptTarget.ES2022,
			lib: worker
				? ['lib.es2022.d.ts', 'lib.webworker.d.ts']
				: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
			types: worker ? ['@cloudflare/workers-types'] : [],
			strict: true,
			skipLibCheck: false,
			noEmit: true
		}
	);
const browser = programOf(
	list.filter((entry) => !WORKER.has(entry.subpath)),
	false
);
const worker = programOf(
	list.filter((entry) => WORKER.has(entry.subpath)),
	true
);
const programOfEntry = (entry) => (WORKER.has(entry.subpath) ? worker : browser);
const errors = [...diagnostics(browser), ...diagnostics(worker)];
let failed = false;
if (errors.length) {
	console.error(`api-report: the emitted declarations do not compile (${errors.length}):`);
	for (const error of errors.slice(0, 40)) console.error(`  ${error}`);
	failed = true;
}
mkdirSync(REPORTS, { recursive: true });
for (const entry of list) {
	const text = report(programOfEntry(entry), entry);
	const file = path.join(REPORTS, `${entry.name}.api.md`);
	if (CHECK) {
		const committed = existsSync(file) ? readFileSync(file, 'utf8') : null;
		if (committed !== text) {
			failed = true;
			const before = new Set(committed?.split('\n') ?? []);
			const after = new Set(text.split('\n'));
			const added = text.split('\n').filter((line) => !before.has(line));
			const removed = (committed?.split('\n') ?? []).filter((line) => !after.has(line));
			console.error(
				`api-report: api/${entry.name}.api.md is not current (pnpm api:report, then review the diff)`
			);
			for (const line of removed.slice(0, 20)) console.error(`  - ${line}`);
			for (const line of added.slice(0, 20)) console.error(`  + ${line}`);
		}
	} else writeFileSync(file, text);
	// The site's reference page (the engine's names-only entry has none).
	if (NAMES_ONLY.has(entry.subpath)) continue;
	const pageFile = path.join(PAGES, `${entry.name}.mdx`);
	const pageText = page(programOfEntry(entry), entry);
	if (CHECK) {
		if (!existsSync(pageFile) || readFileSync(pageFile, 'utf8') !== pageText) {
			failed = true;
			console.error(
				`api-report: site/content/docs/reference/api/${entry.name}.mdx is not current (pnpm api:report)`
			);
		}
	} else {
		mkdirSync(PAGES, { recursive: true });
		writeFileSync(pageFile, pageText);
	}
}
if (coded.size) {
	console.error(
		`api-report: ${coded.size} public JSDoc blocks name an internal ticket code (say what it means, or drop it):`
	);
	for (const [at, codes] of [...coded].sort()) console.error(`  ${at} ${codes.join(', ')}`);
	failed = true;
}
if (failed) process.exit(1);
if (!CHECK) console.log(`api-report: wrote ${list.length} reports to api/`);
