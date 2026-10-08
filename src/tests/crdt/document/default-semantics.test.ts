/**
 * UW-10 — a headless document given the bundled plugins' block roles
 * (`defaultSemantics`) refuses the edits no view could produce: a merge
 * into a divider, a split of a void image, a code line moved out of its
 * island, a paragraph moved directly into a columns layout (`layout.fits`).
 * It is a headless document's default (D4); with `semantics: {}` the
 * facade applies all four (pure engine rules). The
 * columns plugin is not a default plugin of `<Edytor>`, but its layout
 * rows are in `defaultSemantics` (C5), so every replica reads a layout alike.
 */
import { describe, expect, it } from 'vitest';
import {
	codeSemantics,
	createDocument,
	defaultSemantics,
	imageSemantics,
	layoutSemantics,
	mediaSemantics,
	pageSemantics,
	richTextSemantics,
	commentMarks,
	tocSemantics,
	tableSemantics,
	equationSemantics,
	type DocumentSemanticsConfig,
	type EdytorDocument,
	type JSONDoc
} from '../../../lib/crdt/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import { columnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
import { embedPlugin } from '$lib/plugins/media/EmbedPlugin.svelte';
import { bookmarkPlugin } from '$lib/plugins/media/BookmarkPlugin.svelte';
import { filePlugin } from '$lib/plugins/media/FilePlugin.svelte';
import { videoPlugin } from '$lib/plugins/media/VideoPlugin.svelte';
import { audioPlugin } from '$lib/plugins/media/AudioPlugin.svelte';
import { pagePlugin } from '$lib/plugins/page/PagePlugin.svelte';
import { tocPlugin } from '$lib/plugins/toc/TocPlugin.svelte';
import { tablePlugin } from '$lib/plugins/table/TablePlugin.svelte';
import { createEquationPlugin } from '$lib/plugins/equation/EquationPlugin.svelte';

const value: JSONDoc = {
	children: [
		{ id: 'hr', type: 'divider' },
		{ id: 'p', type: 'paragraph', content: [{ text: 'after' }] },
		{
			id: 'img',
			type: 'image',
			data: { src: 'https://example.com/a.png' },
			content: [{ text: 'cap' }]
		},
		{
			id: 'code',
			type: 'code',
			children: [{ id: 'line', type: 'codeLine', content: [{ text: 'a' }] }]
		},
		{ id: 'q', type: 'paragraph', content: [{ text: 'beside' }] },
		{
			id: 'cols',
			type: 'columns',
			children: [
				{ id: 'k1', type: 'column', children: [{ id: 'l', type: 'paragraph' }] },
				{ id: 'k2', type: 'column', children: [{ id: 'r', type: 'paragraph' }] }
			]
		}
	]
};

const edits = (semantics?: DocumentSemanticsConfig) => {
	const document = createDocument({ value, semantics });
	const { facade } = document;
	const statuses = [
		facade.mergeBackward('p').status,
		facade.splitBlock('img', 1, 'img2').status,
		facade.moveBlock('line', { parent: null, index: 0 }).status,
		facade.moveBlock('q', { parent: 'cols', index: 0 }).status
	];
	document.destroy();
	return statuses;
};

/** The adopted non-default rows: roles that are void/island/layout, kinds without content, default children. */
const structural = ({ semantics }: EdytorDocument) => ({
	roles: Object.fromEntries(
		[...semantics.roles].filter(([, r]) => r.void || r.island || r.layout || r.table)
	),
	rendersContent: Object.fromEntries([...semantics.rendersContent].filter(([, r]) => !r)),
	defaultChild: Object.fromEntries(semantics.defaultChild)
});

const BUNDLED = {
	roles: {
		divider: { void: true, island: false, lines: false },
		horizontalRule: { void: true, island: false, lines: false },
		image: { void: true, island: false, lines: false },
		embed: { void: true, island: false, lines: false },
		bookmark: { void: true, island: false, lines: false },
		file: { void: true, island: false, lines: false },
		video: { void: true, island: false, lines: false },
		audio: { void: true, island: false, lines: false },
		page: { void: true, island: false, lines: false },
		toc: { void: true, island: false, lines: false },
		equation: { void: true, island: false, lines: false },
		code: { void: false, island: true, lines: true },
		columns: { void: false, island: false, lines: false, layout: true },
		table: { void: false, island: false, lines: false, table: true },
		tableCell: { void: false, island: true, lines: false }
	},
	rendersContent: {
		divider: false,
		horizontalRule: false,
		'ordered-list': false,
		'unordered-list': false,
		code: false,
		columns: false,
		column: false,
		page: false,
		toc: false,
		table: false,
		tableRow: false,
		equation: false
	},
	defaultChild: {
		'ordered-list': 'list-item',
		'unordered-list': 'list-item',
		code: 'codeLine',
		columns: 'column',
		table: 'tableRow',
		tableRow: 'tableCell'
	}
};

describe('defaultSemantics on a headless document', () => {
	it('refuses a merge into a divider, a void split, a move out of an island and a bare block in a layout', () => {
		expect(edits(defaultSemantics)).toEqual(['refused', 'refused', 'refused', 'refused']);
	});

	it('is the default of a headless document (D4); `semantics: {}` checks no roles', () => {
		expect(edits()).toEqual(['refused', 'refused', 'refused', 'refused']);
		expect(edits({})).toEqual(['applied', 'applied', 'applied', 'applied']);
	});

	it('merges the eight plugin tables', () => {
		expect(defaultSemantics).toEqual({
			roles: {
				...richTextSemantics.roles,
				...codeSemantics.roles,
				...imageSemantics.roles,
				...mediaSemantics.roles,
				...layoutSemantics.roles,
				...pageSemantics.roles,
				...tocSemantics.roles,
				...tableSemantics.roles,
				...equationSemantics.roles
			},
			rendersContent: {
				...richTextSemantics.rendersContent,
				...codeSemantics.rendersContent,
				...imageSemantics.rendersContent,
				...mediaSemantics.rendersContent,
				...layoutSemantics.rendersContent,
				...pageSemantics.rendersContent,
				...tocSemantics.rendersContent,
				...tableSemantics.rendersContent,
				...equationSemantics.rendersContent
			},
			defaultChild: {
				...richTextSemantics.defaultChild,
				...codeSemantics.defaultChild,
				...layoutSemantics.defaultChild,
				...tableSemantics.defaultChild
			},
			// H5: the rich-text plugin's mark edges (the link's), and the comment's
			// anchor, which never grows (`comment.anchor`, WU-34).
			marks: { ...richTextSemantics.marks, ...commentMarks }
		});
	});

	it("is what the bundled plugins' views adopt, and those views attach to it", () => {
		const media = [embedPlugin, bookmarkPlugin, filePlugin, videoPlugin, audioPlugin];
		const plugins = [
			richTextPlugin,
			codePlugin,
			imagePlugin,
			...media,
			columnsPlugin,
			pagePlugin,
			tocPlugin,
			tablePlugin,
			createEquationPlugin()
		];
		const viewed = createDocument({ value });
		const view = new Edytor({ document: viewed, plugins });
		expect(structural(viewed)).toEqual(BUNDLED);

		const headless = createDocument({ value, semantics: defaultSemantics });
		expect(structural(headless)).toEqual(BUNDLED);
		const attached = new Edytor({ document: headless, plugins });
		expect(structural(headless)).toEqual(BUNDLED);

		for (const edytor of [view, attached]) edytor.destroy();
		for (const document of [viewed, headless]) document.destroy();
	});
});
