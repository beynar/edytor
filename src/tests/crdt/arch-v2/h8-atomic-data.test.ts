/**
 * H8 (CRDT study 2026-10; contract row `data.atomic`): a kind declares data
 * paths written as one leaf (`atomic: ['link']`, a role every replica adopts
 * from the same semantics). Per-leaf data merges two concurrent object
 * assignments into a value neither wrote — `{url: a, title: A}` ‖
 * `{url: b, kind: video}` gave `{url: b, title: A, kind: video}`; at an
 * atomic path one of them wins whole, on every client-id pair.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { createDocument, semanticsOf } from '$lib/crdt/index.js';
import { Edytor } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { clientPairs, converge, replica, seedUpdate } from './p1-harness.js';

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};
const semantics = semanticsOf({ embed: { atomic: ['link', ['media', 'source']] } });
const A = { url: 'a', title: 'A' };
const B = { url: 'b', kind: 'video' };
const seeds = [
	{ id: 'e', type: 'embed', text: '', data: { link: { url: 'x', title: 'X' }, size: 1 } },
	{ id: 'p', type: 'paragraph', text: '', data: { link: { url: 'x', title: 'X' } } }
];

/** Each converged `link` of block `id` after Ada and Bob each assign theirs. */
const outcomes = (id: string) => {
	const seen = new Set<string>();
	for (const o of converge(
		seeds,
		2,
		([a, b]) => {
			ok(a.ed.patchData(id, [{ path: ['link'], value: A }]));
			ok(b.ed.patchData(id, [{ path: ['link'], value: B }]));
		},
		{ semantics, assignments: clientPairs(24) }
	)) {
		expect(o.problems).toEqual([]);
		seen.add(JSON.stringify(o.ed.blockDataOf(id).link));
		for (const r of o.reps) r.destroy();
	}
	return [...seen].map((s) => JSON.parse(s));
};

describe('H8: an atomic data path is written as one leaf', () => {
	it('two concurrent assignments: one wins whole, never a hybrid', () => {
		const links = outcomes('e');
		expect(links.length).toBeGreaterThan(0);
		for (const link of links) expect([A, B]).toContainEqual(link);
	});

	it('a kind without the declaration still merges per key (the hole H8 closes)', () => {
		const links = outcomes('p');
		expect(links).toContainEqual({ url: expect.any(String), title: 'A', kind: 'video' });
	});

	it('a write inside an atomic path writes the whole value; other keys stay per leaf', () => {
		const a = replica('ada', seedUpdate(seeds, semantics), 2 ** 26 + 1, { semantics });
		ok(a.ed.patchData('e', [{ path: ['link', 'title'], value: 'Y' }]));
		expect(a.ed.blockDataOf('e')).toEqual({ link: { url: 'x', title: 'Y' }, size: 1 });
		const node = a.ed.resolveBlock('e');
		expect(node.getAttr('d/link')).toEqual({ url: 'x', title: 'Y' });
		expect([...node.attrKeys()].filter((k) => k.startsWith('d/link/'))).toEqual([]);
		// A nested atomic path, an array value, a delete.
		ok(a.ed.patchData('e', [{ path: ['media'], value: { source: { id: 1, tags: ['a'] } } }]));
		expect(node.getAttr('d/media/source')).toEqual({ id: 1, tags: ['a'] });
		expect(a.ed.blockDataOf('e').media).toEqual({ source: { id: 1, tags: ['a'] } });
		ok(a.ed.patchData('e', [{ path: ['link'] }]));
		expect(a.ed.blockDataOf('e')).toEqual({ size: 1, media: { source: { id: 1, tags: ['a'] } } });
		a.destroy();
	});

	it('a sub-key write ‖ an assignment at the atomic path: one whole value wins', () => {
		const seen = new Set<string>();
		for (const o of converge(
			seeds,
			2,
			([a, b]) => {
				ok(a.ed.patchData('e', [{ path: ['link', 'title'], value: 'Y' }]));
				ok(b.ed.patchData('e', [{ path: ['link'], value: B }]));
			},
			{ semantics, assignments: clientPairs(12) }
		)) {
			expect(o.problems).toEqual([]);
			seen.add(JSON.stringify(o.ed.blockDataOf('e').link));
			for (const r of o.reps) r.destroy();
		}
		for (const s of seen) expect([{ url: 'x', title: 'Y' }, B]).toContainEqual(JSON.parse(s));
	});

	it('the document adopts the paths as part of the role; a conflicting declaration throws', () => {
		const document = createDocument({ semantics });
		expect(document.semantics.roles.get('embed')).toMatchObject({
			atomic: [['link'], ['media', 'source']]
		});
		// The same set in another order and spelling is the same declaration.
		document.adoptSemantics({ roles: { embed: { atomic: [['media', 'source'], 'link'] } } });
		expect(() => document.adoptSemantics({ roles: { embed: { atomic: ['link'] } } })).toThrow();
		document.destroy();
	});

	it('a view adopts a kind record’s atomic paths, and its data writes follow them', () => {
		const embedPlugin = () => ({
			blocks: { embed: { snippet: (() => null) as never, atomic: ['link'] } }
		});
		const document = createDocument({
			value: { children: [{ id: 'e', type: 'embed', data: { link: { url: 'x', title: 'X' } } }] }
		});
		const edytor = new Edytor({ document, plugins: [embedPlugin, richTextPlugin] });
		expect(document.semantics.roles.get('embed')).toMatchObject({ atomic: [['link']] });
		edytor.idToBlock.get('e')!.data.link = { url: 'y' };
		expect(document.facade.resolveBlock('e').getAttr('d/link')).toEqual({ url: 'y' });
		expect(document.facade.blockDataOf('e')).toEqual({ link: { url: 'y' } });
		edytor.destroy();
		document.destroy();
	});
});
