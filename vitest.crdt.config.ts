import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

/**
 * CRDT lane: the vendored upstream Yjs v14 test suite (vendor-tests/yjs) plus
 * Edytor's own CRDT engine tests (src/tests/crdt).
 *
 * Deliberately separate from `pnpm test` (vite.config.ts): upstream tests are
 * randomized, slower, and not part of the app gate. Run with `pnpm test:crdt`.
 * The sveltekit plugin is present for the `$lib` alias used by editor-facing
 * CRDT tests (e.g. legacy-v13 fixtures); the vendored engine and upstream
 * tests themselves resolve through literal `lib0-v14` / relative specifiers —
 * no aliasing is used for the vendored code.
 */
export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['vendor-tests/**/*.test.{js,ts}', 'src/tests/crdt/**/*.test.{js,ts}'],
		testTimeout: 300000
	}
});
