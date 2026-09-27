import { cleanup } from '@testing-library/svelte';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';
import { endCellsShadowTest, installCellsShadow, reportCellsCensus } from './cellsShadow.js';
import { endTruthCheck, installTruthCheck } from './truthCheck.js';

beforeEach(installCellsShadow);
beforeEach(installTruthCheck);

afterEach(async () => {
	try {
		// F-O10: before the unmount, every live host equals its cells.
		await endTruthCheck();
	} finally {
		try {
			endCellsShadowTest();
		} finally {
			document.getSelection()?.removeAllRanges();
			cleanup();
		}
	}
});

afterAll(() => {
	const file = expect.getState().testPath ?? '(unknown)';
	reportCellsCensus(file);
});

if (!HTMLElement.prototype.scrollIntoView) {
	HTMLElement.prototype.scrollIntoView = () => {};
}
