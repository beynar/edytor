/**
 * Test-only backend switch for the scenario corpus (arch-v2 D11): the TX, ST,
 * MV, AN and HI scenarios build their adapter through {@link scenarioOps}, so
 * one test file can run the same corpus against the stream-boundary spike.
 * The default stays the model adapter; nothing in production reads this.
 */
// @ts-nocheck -- adapters drive the vendored engine JS directly (excluded lane).
import { createModelOps } from './model-ops.js';
import { createStreamOps } from './stream-ops.js';

let backend: 'model' | 'streams' = 'model';

/** Select the backend for scenario modules imported AFTER this call. */
export const useScenarioBackend = (next: 'model' | 'streams'): void => {
	backend = next;
};

export const scenarioBackend = (): 'model' | 'streams' => backend;

export const scenarioOps = () => (backend === 'streams' ? createStreamOps() : createModelOps());
