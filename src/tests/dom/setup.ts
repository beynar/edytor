import { cleanup } from '@testing-library/svelte';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';
import { endCellsShadowTest, installCellsShadow, reportCellsCensus } from './cellsShadow.js';
import { endTruthCheck, installTruthCheck } from './truthCheck.js';

beforeEach(installCellsShadow);
beforeEach(installTruthCheck);

// A Svelte dev warning fails the test that logs it: library markup must not
// warn in a consumer's dev build (CW-05, a divider's bodied `<hr>`).
// Registered before the unmount below: after-hooks run in reverse (`stack`),
// so the check runs after it and blames an unmount warning on its own test.
let svelteWarnings: string[] = [];
const warn = console.warn;
console.warn = (...args: unknown[]) => {
	if (typeof args[0] === 'string' && args[0].includes('[svelte]')) svelteWarnings.push(args[0]);
	warn(...args);
};
afterEach(() => {
	const [first] = svelteWarnings;
	svelteWarnings = [];
	if (first) throw new Error(`Svelte dev warning: ${first.replace(/%c/g, '')}`);
});

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
