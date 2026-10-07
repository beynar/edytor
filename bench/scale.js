#!/usr/bin/env node
/**
 * The scale timings alone (`pnpm bench:scale`): `bench/lib/scale.js`, the
 * wall-clock half of the gate rows that count operations (CC-05).
 * `pnpm bench:crdt` runs it too and stores it under `scale`. Prints the
 * numbers as JSON and lists the timings past their former budgets (never a
 * failure: a machine's timings are not a gate).
 */
import { scale } from './lib/scale.js';

const result = scale();
console.log(JSON.stringify(result, null, 1));
if (result.over.length > 0) console.log(`over the former budgets:\n  ${result.over.join('\n  ')}`);
