import { cleanup } from '@testing-library/svelte';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';
import { endCellsShadowTest, installCellsShadow, reportCellsCensus } from './cellsShadow.js';

beforeEach(installCellsShadow);

afterEach(() => {
	try {
		endCellsShadowTest();
	} finally {
		document.getSelection()?.removeAllRanges();
		cleanup();
	}
});

afterAll(() => {
	reportCellsCensus(expect.getState().testPath ?? '(unknown)');
});

if (!HTMLElement.prototype.scrollIntoView) {
	HTMLElement.prototype.scrollIntoView = () => {};
}
