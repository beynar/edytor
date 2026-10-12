/**
 * A component whose module script carries the plugin (`<script module>`:
 * `createImagePlugin` and its kind snippets) is never rendered as a
 * component, so an app's bundler drops its own `<style>` (the image
 * alignment rules were lost in production builds). Its CSS lives in a
 * `.css` file the module imports (`import './image.css'`), as the code,
 * table and columns plugins do.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../lib');
const files = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]
	);

describe("a plugin module's styles ship", () => {
	it('no component with a module script under plugins/ keeps its CSS in a <style>', () => {
		const offenders = files(join(root, 'plugins'))
			.filter((path) => path.endsWith('.svelte'))
			.filter((path) => {
				const source = readFileSync(path, 'utf8');
				return source.includes('<script module') && /<style[\s>]/.test(source);
			})
			.map((path) => path.slice(root.length + 1));
		expect(offenders).toEqual([]);
	});
});
