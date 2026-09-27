import { cleanup } from '@testing-library/svelte';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';
import { endCellsShadowTest, installCellsShadow, reportCellsCensus } from './cellsShadow.js';
import {
	endObserverShadowTest,
	installObserverShadow,
	reportObserverCensus
} from './observerShadow.js';

beforeEach(installCellsShadow);
beforeEach(installObserverShadow);

afterEach(() => {
	try {
		endCellsShadowTest();
	} finally {
		document.getSelection()?.removeAllRanges();
		cleanup();
	}
});
// After the unmount: the last flush's passes and repairs are in the log.
afterEach(endObserverShadowTest);

afterAll(() => {
	const file = expect.getState().testPath ?? '(unknown)';
	reportCellsCensus(file);
	reportObserverCensus(file);
});

if (!HTMLElement.prototype.scrollIntoView) {
	HTMLElement.prototype.scrollIntoView = () => {};
}
