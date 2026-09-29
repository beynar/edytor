/**
 * API low (rescore, `crdt/semantics.ts`) — the bundled semantics tables are
 * shared by every document and the room: they are deeply frozen, so one
 * consumer's mutation cannot change another document's roles; `semanticsOf`
 * is exported to build a config from kind rows the same way.
 */
import { describe, expect, it } from 'vitest';
import {
	codeSemantics,
	createDocument,
	defaultSemantics,
	imageSemantics,
	richTextSemantics,
	semanticsOf
} from '../../../lib/crdt/index.js';
import * as root from '../../../lib/index.js';

const frozenDeep = (value: unknown): boolean =>
	value === null ||
	typeof value !== 'object' ||
	(Object.isFrozen(value) && Object.values(value).every(frozenDeep));

describe('semantics tables (API low)', () => {
	it('the bundled tables are deeply frozen', () => {
		for (const table of [defaultSemantics, richTextSemantics, codeSemantics, imageSemantics])
			expect(frozenDeep(table)).toBe(true);
		expect(() => {
			(defaultSemantics.roles as Record<string, unknown>).embed = { void: true };
		}).toThrow(TypeError);
		expect(() => {
			(defaultSemantics.roles.divider as { void?: boolean }).void = false;
		}).toThrow(TypeError);
		expect(defaultSemantics.roles.divider).toEqual({ void: true });
	});

	it('semanticsOf builds a config from kind rows (both entry points)', () => {
		expect(root.semanticsOf).toBe(semanticsOf);
		const semantics = semanticsOf(
			{ embed: { void: true, rendersContent: false } },
			{ board: { island: true, defaultChild: 'card' } }
		);
		expect(semantics).toEqual({
			roles: { embed: { void: true }, board: { island: true } },
			rendersContent: { embed: false },
			defaultChild: { board: 'card' }
		});
		expect(frozenDeep(semantics)).toBe(true);
		const document = createDocument({
			value: { children: [{ type: 'paragraph' }] },
			// The documented merge (reference/document-api): field by field keeps the bundled rows.
			semantics: {
				roles: { ...defaultSemantics.roles, ...semantics.roles },
				rendersContent: { ...defaultSemantics.rendersContent, ...semantics.rendersContent },
				defaultChild: { ...defaultSemantics.defaultChild, ...semantics.defaultChild }
			}
		});
		expect(document.semantics.roles.get('embed')).toEqual({
			void: true,
			island: false,
			lines: false
		});
		expect(document.semantics.roles.get('divider')).toEqual({
			void: true,
			island: false,
			lines: false
		});
		expect(document.semantics.roles.get('code')).toEqual({
			void: false,
			island: true,
			lines: true
		});
		expect(document.semantics.rendersContent.get('embed')).toBe(false);
		expect(document.semantics.rendersContent.get('divider')).toBe(false);
		expect(document.semantics.defaultChild.get('code')).toBe('codeLine');
		expect(document.semantics.defaultChild.get('board')).toBe('card');
		document.destroy();
	});
});
