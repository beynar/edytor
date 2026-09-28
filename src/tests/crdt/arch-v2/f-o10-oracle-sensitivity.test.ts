// @vitest-environment jsdom
/**
 * F-O10 oracle sensitivity (plan §8.7): the truth oracle (`src/tests/oracles/truth.ts`)
 * and its browser boundary (`tests/truthCheck.ts`) must fail on the damage they
 * exist to catch, and stay green on the legitimate shapes. The first five rows
 * are the independent review of 2026-09-29 (two were red on 5e21dad: a paragraph
 * whose every text host was removed passed, and a `page.evaluate` exception
 * counted as success); the rest are the variants added with the fix.
 */
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, test } from 'vitest';
import { truthOf } from '../../oracles/truth.js';
import { assertTruth } from '../../../../tests/truthCheck.js';

type Run = { kind: 'text'; text: string } | { kind: 'inline'; id: string };
type Spec = { id: string; type?: string; runs: Run[]; void?: boolean; parts?: Element[] };

const hostOf = (text: string) => {
	const span = document.createElement('span');
	span.setAttribute('data-edytor-text', 'true');
	span.textContent = text;
	return span;
};
const atomOf = (id: string) => {
	const span = document.createElement('span');
	span.setAttribute('data-edytor-inline-block', 'true');
	span.setAttribute('data-edytor-id', id);
	span.textContent = '@';
	return span;
};

/** A host rendering `specs` (each block's `parts`, else one text host of its text), and a view over it. */
const view = (specs: Spec[], extra: Record<string, unknown> = {}) => {
	const root = document.createElement('div');
	const cells = new Map<string, { type: string; runs: Run[]; childIds: string[] }>();
	for (const spec of specs) {
		const block = document.createElement('div');
		block.setAttribute('data-edytor-block', 'true');
		block.setAttribute('data-edytor-id', spec.id);
		if (spec.void) block.setAttribute('data-edytor-void', 'true');
		const text = spec.runs.map((run) => (run.kind === 'text' ? run.text : '')).join('');
		block.append(...(spec.parts ?? [hostOf(text)]));
		root.append(block);
		cells.set(spec.id, { type: spec.type ?? 'paragraph', runs: spec.runs, childIds: [] });
	}
	document.body.append(root);
	return {
		node: root,
		destroyed: false,
		readonly: false,
		composition: { live: false },
		blocks: new Map<string, { rendersContent?: boolean }>([
			['paragraph', {}],
			['list', { rendersContent: false }],
			['divider', { rendersContent: false }]
		]),
		cells: { rootIds: specs.map((spec) => spec.id), get: (id: string) => cells.get(id) },
		...extra
	};
};

const paragraph = () => {
	const text = hostOf('hello');
	return {
		text,
		edytor: view([{ id: 'p', runs: [{ kind: 'text', text: 'hello' }], parts: [text] }])
	};
};

/** Only these two Page methods are used by the actual browser oracle boundary. */
const pageWithEvaluation = (evaluate: () => Promise<string[] | null>, closed = false) =>
	({ isClosed: () => closed, evaluate }) as unknown as Page;

afterEach(() => document.body.replaceChildren());

describe('2026-09-29 independent F-O10 sensitivity review', () => {
	test('control: intact paragraph passes', () => {
		expect(truthOf(paragraph().edytor)).toEqual([]);
	});

	test('control: wrong rendered text is detected', () => {
		const fixture = paragraph();
		fixture.text.textContent = 'corrupted';
		expect(truthOf(fixture.edytor)).toEqual(['p: DOM "corrupted" ≠ cell "hello"']);
	});

	test('missing every text host must be detected for a nonempty paragraph', () => {
		const fixture = paragraph();
		fixture.text.remove();
		expect(
			truthOf(fixture.edytor),
			'An ordinary paragraph still owns hello, but its only text host was removed'
		).not.toEqual([]);
	});

	test('control: browser evaluation reporting corruption fails assertTruth', async () => {
		const page = pageWithEvaluation(async () => ['p: no block element']);
		await expect(assertTruth(page, 'corruption control')).rejects.toThrow('p: no block element');
	});

	test('a browser oracle evaluation error must fail rather than count as success', async () => {
		const failure = new Error('review canary: page.evaluate could not inspect the live editor');
		const page = pageWithEvaluation(async () => {
			throw failure;
		});
		await expect(assertTruth(page, 'evaluation failure')).rejects.toThrow(failure.message);
	});
});

describe('F-O10 missing text hosts: variants', () => {
	test('the missing host is named with the text it should show', () => {
		const fixture = paragraph();
		fixture.text.remove();
		expect(truthOf(fixture.edytor)).toEqual(['p: no text element for cell "hello"']);
	});

	test('text hosts removed around a surviving atom are detected', () => {
		const edytor = view([
			{
				id: 'p',
				runs: [
					{ kind: 'text', text: 'hi ' },
					{ kind: 'inline', id: 'm' },
					{ kind: 'text', text: '' }
				],
				parts: [atomOf('m')]
			}
		]);
		expect(truthOf(edytor)).toEqual(['p: DOM "￼" ≠ cell "hi ￼"']);
	});

	test('legitimate shapes stay green', () => {
		const edytor = view([
			// An empty block: nothing to host.
			{ id: 'empty', runs: [{ kind: 'text', text: '' }], parts: [] },
			// A void block renders no content of its own.
			{ id: 'void', runs: [{ kind: 'text', text: 'alt' }], void: true, parts: [] },
			// Kinds that declare no content slot (`rendersContent: false`).
			{ id: 'list', type: 'list', runs: [{ kind: 'text', text: 'stale' }], parts: [] },
			{ id: 'hr', type: 'divider', runs: [], parts: [] },
			// A content of atoms only: the atoms are its parts.
			{
				id: 'atoms',
				runs: [
					{ kind: 'text', text: '' },
					{ kind: 'inline', id: 'a' },
					{ kind: 'text', text: '' }
				],
				parts: [atomOf('a')]
			}
		]);
		expect(truthOf(edytor)).toEqual([]);
	});

	test('the live composition host is the IME’s: not compared, not reported', () => {
		const edytor = view([{ id: 'p', runs: [{ kind: 'text', text: 'hello' }], parts: [] }], {
			composition: { live: true, host: { parent: { id: 'p' } } }
		});
		expect(truthOf(edytor)).toEqual([]);
	});
});

describe('F-O10 browser boundary: variants', () => {
	test('a closed page has no view to check', async () => {
		const page = pageWithEvaluation(async () => {
			throw new Error('never evaluated');
		}, true);
		await expect(assertTruth(page, 'closed')).resolves.toBeUndefined();
	});

	test('a page with no view passes (null), a settled clean view passes ([])', async () => {
		await expect(
			assertTruth(
				pageWithEvaluation(async () => null),
				'no view'
			)
		).resolves.toBe(undefined);
		await expect(
			assertTruth(
				pageWithEvaluation(async () => []),
				'clean'
			)
		).resolves.toBe(undefined);
	});

	test('the evaluation error keeps its label and cause', async () => {
		const failure = new Error('Execution context was destroyed');
		const page = pageWithEvaluation(async () => {
			throw failure;
		});
		const error = await assertTruth(page, 'label').catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('F-O10 (label)');
		expect((error as Error).cause).toBe(failure);
	});
});
