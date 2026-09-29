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
	['through the `Keymap`', 'the Keymap class is not exported; bindings go through `hotKeys`']
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

	it('no source comment cites a README section (the README is a landing page)', () => {
		const hits = sources(join(root, 'src/lib'))
			.filter((path) => readFileSync(path, 'utf8').includes('README'))
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});
});
