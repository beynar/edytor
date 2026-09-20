import { cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';

afterEach(() => {
	document.getSelection()?.removeAllRanges();
	cleanup();
});

if (!HTMLElement.prototype.scrollIntoView) {
	HTMLElement.prototype.scrollIntoView = () => {};
}
