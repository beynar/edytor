/**
 * Vitest adapter for the vendored upstream Yjs v14 test suite.
 *
 * Upstream runs these files through `lib0/testing`'s `runTests()` (see
 * `tests/index.js`, upstream script `npm test` = `node ./tests/index.js
 * --repetition-time 50`). Each test module exports `testXxx(tc)` functions
 * that receive a `lib0/testing` `TestCase` (its `.prng` seeds all randomness).
 *
 * This adapter keeps the engine code and test code byte-faithful to upstream
 * (modulo the import-specifier patches recorded in
 * `src/lib/crdt/vendor/yjs/UPSTREAM.md`) and only replaces the *runner*: every
 * `testXxx` export is registered as a vitest test, executed sequentially in
 * upstream's `tests/index.js` module order.
 *
 * Semantics differences vs the upstream runner (recorded, not hidden):
 * - `testRepeat*` tests are run once; upstream repeats them for
 *   `--repetition-time` ms (default 50ms). No repetition under vitest.
 * - `t.skip()` throws lib0's internal `SkipError`; we map it to `ctx.skip()`.
 * - PRNG seed: upstream prints `--seed N` on failure. Here set the env var
 *   `YJS_TEST_SEED=<n>` to pin every TestCase seed for reproduction, e.g.
 *   `YJS_TEST_SEED=12345 pnpm test:crdt`. Without it, seeds are random (same
 *   as upstream when `--seed` is not passed).
 */
import { describe, test } from 'vitest'
import * as t from 'lib0-v14/testing'

import * as yMap from './tests/y-map.tests.js'
import * as yArray from './tests/y-array.tests.js'
import * as yText from './tests/y-text.tests.js'
import * as yXml from './tests/y-xml.tests.js'
import * as encoding from './tests/encoding.tests.js'
import * as undoredo from './tests/undo-redo.tests.js'
import * as compatibility from './tests/compatibility.tests.js'
import * as doc from './tests/doc.tests.js'
import * as updates from './tests/updates.tests.js'
import * as relativePositions from './tests/relativePositions.tests.js'
import * as idset from './tests/IdSet.tests.js'
import * as idmap from './tests/IdMap.tests.js'
import * as attribution from './tests/attribution.tests.js'
import * as delta from './tests/delta.tests.js'
import * as schema from './tests/schema.tests.js'

// Upstream `tests/index.js` execution order.
const modules = {
	doc,
	'y-map': yMap,
	'y-array': yArray,
	'y-text': yText,
	'y-xml': yXml,
	encoding,
	'undo-redo': undoredo,
	compatibility,
	updates,
	relativePositions,
	IdSet: idset,
	IdMap: idmap,
	attribution,
	delta,
	schema
}

const seedEnv = process.env.YJS_TEST_SEED

for (const [moduleName, mod] of Object.entries(modules)) {
	describe(moduleName, () => {
		for (const [name, f] of Object.entries(mod)) {
			if (!name.startsWith('test') || typeof f !== 'function') continue
			test(name, async (ctx) => {
				const tc = new t.TestCase(moduleName, name)
				if (seedEnv != null) {
					// pin the lazily-created PRNG seed for deterministic reproduction
					tc._seed = Number.parseInt(seedEnv, 10)
				}
				try {
					await f(tc)
				} catch (err) {
					// lib0/testing's `t.skip()` throws a module-private SkipError
					if (err?.constructor?.name === 'SkipError') {
						return ctx.skip()
					}
					throw err
				}
			})
		}
	})
}
