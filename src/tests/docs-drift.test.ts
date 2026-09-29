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

const stale: [phrase: string, why: string][] = [
	['another list item', 'Enter ends a run under a continuing kind, not only a list item'],
	['serverUrl/roomName are required', 'createWebsocketSync takes { server, room }'],
	['Prism', 'the code plugin highlights with TanStack Highlight'],
	['mention-and-image', 'the mention plugin is not exported; link targets moved'],
	['14003', 'the generation word is 14004 (schema generation 4)']
];

describe('docs drift', () => {
	it.each(stale)('no doc says "%s" (%s)', (phrase) => {
		const hits = docs
			.filter((path) => readFileSync(path, 'utf8').includes(phrase))
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});
});
