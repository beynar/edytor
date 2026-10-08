/**
 * WU-12 (API-05, API-06, decision D4) — one source of truth for block roles:
 *
 * - a headless `createDocument`/`loadDocument` adopts `defaultSemantics`
 *   unless given its own (`semantics: {}` checks no roles), as the room does;
 * - `semanticsOf` reads plugin kind records (their structural fields only:
 *   a snippet, an element or a preset is not a role);
 * - `mergeSemantics` merges configs field by field (a top-level spread
 *   would drop the bundled rows), refusing a kind two configs disagree on;
 * - the bundled kind tables are exported, so a plugin's rows and the
 *   room's are one value;
 * - a document advertises its roles' digest in its presence (development
 *   builds), and `semanticsMismatch` names the kinds a room disagrees on.
 */
import { describe, expect, it } from 'vitest';
import {
	codeKinds,
	createDocument,
	defaultSemantics,
	imageKinds,
	layoutKinds,
	loadDocument,
	mergeSemantics,
	richTextKinds,
	richTextMarks,
	SemanticConflictError,
	semanticsDigest,
	semanticsMismatch,
	semanticsOf,
	type JSONDoc
} from '../../../lib/crdt/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';

const value: JSONDoc = {
	children: [
		{ id: 'hr', type: 'divider' },
		{ id: 'p', type: 'paragraph', content: [{ text: 'after' }] }
	]
};

describe('a headless document holds the bundled roles by default (D4)', () => {
	it('createDocument() refuses a merge into a divider and knows the default children', () => {
		const document = createDocument({ value });
		expect(document.rendersContent('divider')).toBe(false);
		expect(document.defaultChild('code')).toBe('codeLine');
		expect(document.defaultChild('columns')).toBe('column');
		expect(document.facade.mergeBackward('p').status).toBe('refused');
		document.destroy();
	});

	it('semantics: {} checks no roles', () => {
		const document = createDocument({ value, semantics: {} });
		expect(document.rendersContent('divider')).toBe(true);
		expect(document.facade.mergeBackward('p').status).toBe('applied');
		document.destroy();
	});

	it('loadDocument too', () => {
		const saved = createDocument({ value, semantics: {} });
		const update = saved.encode();
		saved.destroy();
		const loaded = loadDocument(update);
		expect(loaded.facade.mergeBackward('p').status).toBe('refused');
		loaded.destroy();
	});

	it("a kind redefined against the bundled rows conflicts; semantics: {} leaves the view's", () => {
		const embed = { roles: { image: { void: false } } };
		expect(() => createDocument().adoptSemantics(embed)).toThrow(SemanticConflictError);
		const own = createDocument({ semantics: {} });
		expect(() => own.adoptSemantics(embed)).not.toThrow();
		own.destroy();
	});
});

describe('semanticsOf reads plugin kind records', () => {
	it('keeps the structural fields of each record and nothing else', () => {
		const snippet = () => {};
		const blocks = {
			widget: {
				void: true,
				rendersContent: false,
				atomic: ['link'],
				element: 'figure',
				snippet,
				presets: [{ label: 'Embed' }]
			},
			note: snippet,
			callout: { island: true, defaultChild: 'paragraph', container: true, continues: false }
		};
		expect(semanticsOf(blocks)).toEqual({
			roles: { widget: { void: true, atomic: ['link'] }, note: {}, callout: { island: true } },
			rendersContent: { widget: false },
			defaultChild: { callout: 'paragraph' }
		});
	});

	it("a view's kind records give back the bundled tables", () => {
		const view = new Edytor({ plugins: [richTextPlugin, codePlugin, imagePlugin] });
		const ofView = semanticsOf(Object.fromEntries(view.blocks));
		expect(() => mergeSemantics(defaultSemantics, ofView)).not.toThrow();
		for (const [type, row] of Object.entries({ ...richTextKinds, ...codeKinds, ...imageKinds })) {
			const { rendersContent, defaultChild, ...role } = row as typeof row & {
				rendersContent?: boolean;
				defaultChild?: string;
			};
			expect(ofView.roles[type]).toEqual(role);
			expect(ofView.rendersContent[type]).toBe(rendersContent);
			expect(ofView.defaultChild[type]).toBe(defaultChild);
		}
		view.destroy();
	});
});

describe('mergeSemantics', () => {
	const embed = semanticsOf({ widget: { void: true, rendersContent: false, atomic: ['link'] } });

	it('merges field by field and keeps the bundled rows', () => {
		const merged = mergeSemantics(defaultSemantics, embed, {
			marks: { comment: { edge: 'exclusive' } }
		});
		expect(merged.roles).toEqual({
			...defaultSemantics.roles,
			widget: { void: true, atomic: ['link'] }
		});
		expect(merged.rendersContent).toEqual({ ...defaultSemantics.rendersContent, widget: false });
		expect(merged.defaultChild).toEqual(defaultSemantics.defaultChild);
		expect(merged.marks).toEqual({ ...richTextMarks, comment: { edge: 'exclusive' } });
		expect(merged.defaultType).toBeUndefined();
		expect(Object.isFrozen(merged.roles.widget)).toBe(true);
		// The room and a headless document read it as they read the bundled one.
		const document = createDocument({ semantics: merged });
		expect(document.rendersContent('widget')).toBe(false);
		expect(document.rendersContent('divider')).toBe(false);
		document.destroy();
	});

	it('an equal row merges; a row two configs disagree on throws', () => {
		expect(
			mergeSemantics(defaultSemantics, semanticsOf({ image: { void: true } })).roles.image
		).toEqual({
			void: true
		});
		expect(() =>
			mergeSemantics(defaultSemantics, semanticsOf({ image: { island: true } }))
		).toThrow(SemanticConflictError);
		expect(() => mergeSemantics(defaultSemantics, { defaultChild: { code: 'paragraph' } })).toThrow(
			SemanticConflictError
		);
		expect(() => mergeSemantics({ defaultType: 'heading' }, { defaultType: 'paragraph' })).toThrow(
			SemanticConflictError
		);
		expect(mergeSemantics({ defaultType: 'heading' }, embed).defaultType).toBe('heading');
	});
});

describe('the bundled kind tables are exported', () => {
	it('as the rows the plugins spread', () => {
		expect(richTextKinds.divider).toEqual({ void: true, rendersContent: false });
		expect(codeKinds.code).toMatchObject({ island: true, lines: true, defaultChild: 'codeLine' });
		expect(imageKinds.image).toEqual({ void: true });
		expect(layoutKinds.columns).toMatchObject({ layout: true, defaultChild: 'column' });
	});
});

describe('the semantics digest (dev-time check)', () => {
	it('one hash per kind, mark and the default type: equal facts hash equal', () => {
		const digest = semanticsDigest(defaultSemantics);
		expect(Object.keys(digest)).toEqual(
			expect.arrayContaining(['divider', 'code', 'columns', 'mark:link', '@defaultType'])
		);
		expect(semanticsDigest(mergeSemantics(defaultSemantics, {}))).toEqual(digest);
		expect(semanticsDigest(semanticsOf({ divider: { void: true } })).divider).not.toBe(
			digest.divider
		);
	});

	it('names the kinds a client declares otherwise than the room', () => {
		const room = semanticsDigest(defaultSemantics);
		const client = semanticsDigest(
			mergeSemantics(semanticsOf({ ...richTextKinds, paragraph: {}, widget: { void: true } }), {
				marks: richTextMarks,
				defaultType: 'paragraph'
			})
		);
		expect(semanticsMismatch(room, client)).toEqual(['widget']);
		// A kind the client does not know is not its mismatch (a view without the plugin).
		expect(semanticsMismatch(room, semanticsDigest(semanticsOf(richTextKinds)))).toEqual([]);
		expect(
			semanticsMismatch(room, {
				'@defaultType': semanticsDigest({ defaultType: 'heading' })['@defaultType']
			})
		).toEqual(['@defaultType']);
		// Not a digest: nothing to compare.
		expect(semanticsMismatch(room, 'nope')).toEqual([]);
		expect(semanticsMismatch(room, { divider: 3 })).toEqual([]);
	});

	it("a document advertises its roles' digest in its presence, and a view's plugins agree with the room", () => {
		const document = createDocument();
		expect(document.awareness.getLocalState()?.semantics).toEqual(
			semanticsDigest(mergeSemantics(defaultSemantics, { defaultType: 'paragraph' }))
		);
		const view = new Edytor({ document, plugins: [richTextPlugin, codePlugin, imagePlugin] });
		const advertised = document.awareness.getLocalState()?.semantics;
		expect(advertised).toHaveProperty('codeLine');
		expect(semanticsMismatch(semanticsDigest(defaultSemantics), advertised)).toEqual([]);

		document.adoptSemantics(semanticsOf({ widget: { void: true } }));
		expect(
			semanticsMismatch(
				semanticsDigest(defaultSemantics),
				document.awareness.getLocalState()?.semantics
			)
		).toEqual(['widget']);
		view.destroy();
		document.destroy();
	});
});
