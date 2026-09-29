/**
 * Documentation drift guard (UW-44). Behavior rules live once, in the site
 * (`customization/hotkeys#enter-and-backspace-by-role`); the README and
 * AGENTS.md link to it. These phrases are the known fan-out misses: each one
 * is a rule or fact that changed while a copy kept the old wording.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

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

	it('while the version is a pre-release, the source build names its branch and version', () => {
		const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
		if (!version.includes('-')) return;
		// master still holds 0.0.11: a clone without `-b` builds the wrong package.
		const clones = docs.flatMap((path) =>
			[...readFileSync(path, 'utf8').matchAll(/git clone .*github\.com\/beynar\/edytor.*/g)].map(
				([line]) => `${relative(root, path)}: ${line}`
			)
		);
		expect(clones.length).toBeGreaterThan(0);
		expect(clones.filter((line) => !/ -b \S+/.test(line))).toEqual([]);
		const tarballs = docs.flatMap((path) =>
			[...readFileSync(path, 'utf8').matchAll(/edytor-[\w.<>-]+\.tgz/g)].map(([name]) => name)
		);
		expect(tarballs.filter((name) => name !== `edytor-${version}.tgz`)).toEqual([]);
		// "Edit this page" links built on master would 404.
		expect(readFileSync(join(root, 'site/blume.config.ts'), 'utf8')).not.toMatch(
			/branch:\s*["']master["']/
		);
	});

	it('no source comment cites a README section (the README is a landing page)', () => {
		const hits = sources(join(root, 'src/lib'))
			.filter((path) => readFileSync(path, 'utf8').includes('README'))
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});
});
