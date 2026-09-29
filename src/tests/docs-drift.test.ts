/**
 * Documentation drift guard (UW-44). Behavior rules live once, in the site
 * (`customization/hotkeys#enter-and-backspace-by-role`); the README and
 * AGENTS.md link to it. These phrases are the known fan-out misses: each one
 * is a rule or fact that changed while a copy kept the old wording.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JSONDoc } from '$lib/utils/json.js';
import { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

const root = join(import.meta.dirname, '../..');

const files = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? files(path) : /\.mdx?$/.test(entry.name) ? [path] : [];
	});

const docs = [
	join(root, 'README.md'),
	join(root, 'AGENTS.md'),
	...files(join(root, 'site/content/docs'))
];

const stale: [phrase: string | RegExp, why: string][] = [
	['another list item', 'Enter ends a run under a continuing kind, not only a list item'],
	['serverUrl/roomName are required', 'createWebsocketSync takes { server, room }'],
	['Prism', 'the code plugin highlights with TanStack Highlight'],
	['mention-and-image', 'the mention plugin is not exported; link targets moved'],
	['14003', 'the generation word is 14004 (schema generation 4)'],
	['0.0.x', 'the package is 0.1.0-next.0, a pre-release'],
	[
		/\b(?:npm i|npm install|pnpm add|yarn add|bun add) edytor(?![@\w/.-])/,
		'a bare `edytor` installs the incompatible 0.0.11 from npm; install `edytor@next`'
	],
	['through the `Keymap`', 'the Keymap class is not exported; bindings go through `hotKeys`'],
	[
		'registered to whoever delivers them first',
		'a dial owns its own client id; relayed ids stay unowned (NW-01)'
	],
	[
		"a write under another user's client id",
		"the room strips content under another user's id and keeps the socket open (NW-01)"
	],
	['refuses updates under another user', 'the room strips those updates; it does not refuse them'],
	[
		/\.\.\.semanticsOf\(|build a table with `semanticsOf` and spread it/,
		'a top-level spread replaces the bundled roles; merge `roles`, `rendersContent` and `defaultChild` one by one'
	],
	[
		/also makes what `body` runs one step|`dispatcher\.run\(kind, body\)` \(also a prevention scope\) or/,
		'`run` only groups synchronous commands within the capture window; `transact` is the one-step guarantee (FW-13)'
	],
	[
		/`1008` or `4xxx` close, after which/,
		'`4401` is retried: only `1008` and the other `4xxx` codes are terminal (FW-15)'
	]
];

const has = (text: string, phrase: string | RegExp) =>
	typeof phrase === 'string' ? text.includes(phrase) : phrase.test(text);

const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sources(path);
		return /\.(ts|js|svelte)$/.test(entry.name) ? [path] : [];
	});

describe('docs drift', () => {
	it.each(stale)('no doc says "%s" (%s)', (phrase) => {
		const hits = docs
			.filter((path) => has(readFileSync(path, 'utf8'), phrase))
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});

	it('while the version is a pre-release, every install names the tarball the site hosts (FW-03)', () => {
		const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
		if (!version.includes('-')) return;
		const config = readFileSync(join(root, 'site/blume.config.ts'), 'utf8');
		const site = /cloudflare\(\{\s*site:\s*["']([^"']+)["']/.exec(config)?.[1];
		expect(site).toBeTruthy();
		const hosted = `${site}/edytor-${version}.tgz`;
		const lines = (path: string) =>
			readFileSync(path, 'utf8')
				.split('\n')
				.map((line) => [`${relative(root, path)}: ${line.trim()}`, line] as const);
		// Every install of edytor: the hosted tarball, a local build of it, or the tag.
		const installs = docs
			.flatMap(lines)
			.filter(([, line]) =>
				/\b(?:npm i|npm install|pnpm add|yarn add|bun add) \S*edytor/.test(line)
			);
		const allowed = [hosted, `../edytor/edytor-${version}.tgz`, 'edytor@next'];
		expect(installs.filter(([, line]) => !allowed.some((target) => line.includes(target)))).toEqual(
			[]
		);
		// The branch is not on the remote: the README, the install page and the
		// server quick start give the hosted tarball, which needs no clone.
		for (const page of [
			'README.md',
			'site/content/docs/getting-started/index.mdx',
			'site/content/docs/server/quick-start.mdx'
		])
			expect(readFileSync(join(root, page), 'utf8'), page).toContain(`pnpm add ${hosted}`);
		// The site serves public/ at its root: the pack script must put the
		// tarball there under the documented name.
		expect(readFileSync(join(root, 'site/scripts/pack-edytor.sh'), 'utf8')).toMatch(
			/cp site\/vendor\/edytor\.tgz "site\/public\/edytor-\$VERSION\.tgz"/
		);
		// A clone of master builds 0.0.11: any clone line must name its branch.
		const clones = docs
			.flatMap(lines)
			.filter(([, line]) => /git clone .*github\.com\/beynar\/edytor/.test(line));
		expect(clones.filter(([, line]) => !/ -b \S+/.test(line))).toEqual([]);
		const tarballs = docs.flatMap((path) =>
			[...readFileSync(path, 'utf8').matchAll(/edytor-[\w.<>-]+\.tgz/g)].map(([name]) => name)
		);
		expect(tarballs.filter((name) => name !== `edytor-${version}.tgz`)).toEqual([]);
		// "Edit this page" links built on master would 404.
		expect(config).not.toMatch(/branch:\s*["']master["']/);
	});

	it('the canonical migration list names every prop, sync option and payload hook added since 0.0.11 (FW-15)', () => {
		const migration = readFileSync(join(root, 'site/content/docs/reference/migration.mdx'), 'utf8');
		const read = (path: string) => readFileSync(join(root, path), 'utf8');
		/** The `name?:` keys of the type literal that starts at `start`. */
		const keys = (source: string, start: string) => {
			const body = source.slice(source.indexOf(start));
			const block = body.slice(0, body.search(/^\t?};/m));
			const depth = /^(\t+)\w+\??:/m.exec(block)?.[1] ?? '\t';
			return [...block.matchAll(new RegExp(`^${depth}(\\w+)\\??:`, 'gm'))].map(([, key]) => key);
		};
		// <Edytor> props 0.0.11 already had.
		const old = new Set(
			'plugins class edytor doc awareness readonly hotKeys onChange onSelectionChange value placeholder sync'.split(
				' '
			)
		);
		const props = keys(read('src/lib/components/Edytor.svelte'), 'export type EdytorProps').filter(
			(key) => !old.has(key)
		);
		const providers = read('src/lib/crdt/providers/index.ts');
		const options = keys(providers, 'export type WebsocketSyncOptions');
		const payload = keys(providers, 'export type EdytorSyncPayload').filter(
			(key) => !['doc', 'awareness', 'synced'].includes(key)
		);
		expect(props).toContain('onSyncExpired');
		expect(options).toContain('connectTimeout');
		expect(payload).toContain('holdBound');
		const missing = [...props, ...options, ...payload].filter(
			(key) => !new RegExp(`[\`.]${key}\\b`).test(migration)
		);
		expect(missing).toEqual([]);
		// Close codes a client reacts to, and the provider events that report them.
		for (const term of ['`4401`', '`4403`', '`4409`', '`1011`', '`expired`', '`unreachable`'])
			expect(migration, term).toContain(term);
		// Only 4401 among the 4xxx codes is retried.
		expect(migration).not.toMatch(/`1008` or `4xxx` close,/);
	});

	it('the operations page has a payload row for every dispatched operation', () => {
		const page = readFileSync(join(root, 'site/content/docs/plugins/operations.mdx'), 'utf8');
		const names = new Set(
			['src/lib/block', 'src/lib/text']
				.flatMap((dir) => sources(join(root, dir)))
				.concat(join(root, 'src/lib/edytor.svelte.ts'))
				.flatMap((path) => [...readFileSync(path, 'utf8').matchAll(/\bbatch\(\s*'(\w+)'/g)])
				.map(([, name]) => name)
				// Normalization runs inside the command that requested it; hooks never see it.
				.filter((name) => !name.startsWith('normalize'))
		);
		expect(names.size).toBeGreaterThan(20);
		const rows = page.split('\n').filter((line) => line.startsWith('| `'));
		expect([...names].filter((name) => !rows.some((row) => row.includes(`\`${name}\``)))).toEqual(
			[]
		);
	});

	it('no source comment tells a reader to spread semantics (FW-14)', () => {
		// An IDE hover is documentation too: a top-level spread of two configs
		// keeps only the last `roles` and drops the bundled void/island rows.
		const hits = sources(join(root, 'src/lib'))
			.filter((path) => /spread it to extend|\.\.\.semanticsOf\(/i.test(readFileSync(path, 'utf8')))
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});

	it('no source comment cites a README section (the README is a landing page)', () => {
		const hits = sources(join(root, 'src/lib'))
			.filter((path) => readFileSync(path, 'utf8').includes('README'))
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});
});

/**
 * Claims the docs make about behavior, pinned where a reader would act on
 * them. Expected values are the documented ones (`editor/commands`).
 */
describe('documented command results (editor/commands)', () => {
	const value: JSONDoc = {
		children: ['a', 'b', 'c', 'd'].map((id) => ({
			id,
			type: 'paragraph',
			content: [{ text: id }]
		}))
	};
	const view = (plugins: Plugin[] = []) =>
		new Edytor({ value: structuredClone(value), plugins: [...plugins, richTextPlugin] });
	const ids = (edytor: Edytor) => edytor.root!.children.map((block) => block.id);

	it('a creating command answers null when the document refuses, undefined when it never ran', () => {
		const edytor = view();
		const a = edytor.idToBlock.get('a')!;
		// The document refuses a reused id.
		expect(a.insertBlockAfter({ block: { id: 'b', type: 'paragraph' } })).toBeNull();
		expect(edytor.dispatcher.last?.status).toBe('refused');
		edytor.readonly = true;
		expect(a.insertBlockAfter({ block: { type: 'paragraph' } })).toBeUndefined();
		expect(edytor.dispatcher.last?.status).toBe('refused');
		const vetoed = view([
			() => ({
				onBeforeOperation: ({ operation, prevent }) => operation === 'insertBlockAfter' && prevent()
			})
		]);
		expect(
			vetoed.idToBlock.get('a')!.insertBlockAfter({ block: { type: 'paragraph' } })
		).toBeUndefined();
		expect(vetoed.dispatcher.last?.status).toBe('refused');
		expect(ids(vetoed)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('a direction move keeps document order; a target move keeps the order given', () => {
		const edytor = view();
		const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => edytor.idToBlock.get(id)!);
		edytor.moveBlocks({ blocks: [c!, b!], direction: 'up' });
		expect(ids(edytor)).toEqual(['b', 'c', 'a', 'd']);
		edytor.moveBlocks({ blocks: [a!, b!], target: d!, position: 'after' });
		expect(ids(edytor)).toEqual(['c', 'd', 'a', 'b']);
		edytor.moveBlocks({ blocks: [b!, a!], target: c!, position: 'before' });
		expect(ids(edytor)).toEqual(['b', 'a', 'c', 'd']);
	});
});
