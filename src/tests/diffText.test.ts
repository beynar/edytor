/** The adoption diff (R8, D57, §5 L32): common prefix/suffix, ambiguity resolved by the caret. */
import { describe, expect, it } from 'vitest';
import { diffText } from '$lib/utils/diffText.js';

describe('diffText', () => {
	it('equal texts have no change', () => {
		expect(diffText('hello', 'hello')).toBeNull();
	});

	it('a long rewrite keeps its common prefix and suffix (reader C4)', () => {
		const [a, b] = ['p'.repeat(200), 's'.repeat(200)];
		expect(diffText(a + 'x'.repeat(700) + b, a + 'y'.repeat(700) + b)).toEqual({
			at: 200,
			remove: 700,
			insert: 'y'.repeat(700)
		});
	});

	it('a deletion between doubled letters ends at the caret (BI-8)', () => {
		expect(diffText('hello', 'helo', 2)).toEqual({ at: 2, remove: 1, insert: '' });
		expect(diffText('hello', 'helo', 3)).toEqual({ at: 3, remove: 1, insert: '' });
		// No preference: after the longest common prefix.
		expect(diffText('hello', 'helo')).toEqual({ at: 3, remove: 1, insert: '' });
	});

	it('an insertion inside a repeat ends at the caret', () => {
		expect(diffText('hello', 'helllo', 3)).toEqual({ at: 2, remove: 0, insert: 'l' });
		expect(diffText('foo foo', 'foo foo foo', 4)).toEqual({ at: 0, remove: 0, insert: 'foo ' });
	});

	it('a repeated word: the deleted one is the one the caret names', () => {
		expect(diffText('foo foo', 'foo', 0)).toEqual({ at: 0, remove: 4, insert: '' });
		expect(diffText('foo foo', 'foo', 3)).toEqual({ at: 3, remove: 4, insert: '' });
	});

	it('never splits a surrogate pair', () => {
		expect(diffText('a😀😀', 'a😀', 1)).toEqual({ at: 1, remove: 2, insert: '' });
		expect(diffText('a😀😀', 'a😀', 2)).toEqual({ at: 1, remove: 2, insert: '' });
	});
});
