import { cleanup } from '@testing-library/svelte';
import { afterAll, afterEach, expect } from 'vitest';
import { assertShadowExplained, compareAllShadows, reportShadowCensus } from './selectionShadow.js';

afterEach(() => {
	try {
		compareAllShadows('test end');
	} finally {
		document.getSelection()?.removeAllRanges();
		cleanup();
	}
	assertShadowExplained();
});

afterAll(() => {
	reportShadowCensus(expect.getState().testPath ?? '(unknown)');
});

if (!HTMLElement.prototype.scrollIntoView) {
	HTMLElement.prototype.scrollIntoView = () => {};
}
