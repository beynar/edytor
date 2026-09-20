/**
 * Timing/stat helpers for the CRDT bench harness (U02 §10). Plain node, no
 * deps. Samples are wall-clock `performance.now()` deltas in milliseconds.
 */

/** p-th percentile of a numeric sample (nearest-rank). */
export const percentile = (sorted, p) => {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, idx)];
};

/** Stats object for one array of ms samples. */
export const statsOf = (arr, { warmup = 0 } = {}) => {
	const s = [...arr].sort((a, b) => a - b);
	const sum = arr.reduce((a, b) => a + b, 0);
	return {
		samples: arr.length,
		warmup,
		mean: +(sum / arr.length).toFixed(4),
		p50: +percentile(s, 50).toFixed(4),
		p95: +percentile(s, 95).toFixed(4),
		min: +s[0].toFixed(4),
		max: +s[s.length - 1].toFixed(4)
	};
};

/**
 * Run `fn` for `warmup` + `samples` iterations, return timing stats.
 * `fn(i)` may return a per-iteration sub-measurement (e.g. remote apply ms)
 * collected in parallel as `remote`.
 */
export const measure = (fn, { warmup = 3, samples = 40 } = {}) => {
	for (let i = 0; i < warmup; i++) fn(-1 - i);
	const local = [];
	const remote = [];
	for (let i = 0; i < samples; i++) {
		const t0 = performance.now();
		const r = fn(i);
		local.push(performance.now() - t0);
		if (typeof r === 'number') remote.push(r);
	}
	const out = statsOf(local, { warmup });
	if (remote.length) out.remote = statsOf(remote);
	return out;
};

/** Time one synchronous call once. */
export const once = (fn) => {
	const t0 = performance.now();
	const out = fn();
	return { ms: +(performance.now() - t0).toFixed(4), out };
};
