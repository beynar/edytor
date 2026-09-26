/**
 * Timing/stat helpers for the CRDT bench harness (U02 §10, WU5 corrections).
 * Plain node, no deps. Samples are wall-clock `performance.now()` deltas in
 * milliseconds.
 *
 * WU5 correction 1: `measure()` no longer infers a "remote" timing from ANY
 * numeric return — a bare number used to be collected as a timing sample, so
 * workloads that returned `updateBytes` (a byte count) produced a `remote`
 * field that was actually bytes-in-ms-clothing. Sub-measurements are now
 * EXPLICIT: `fn` returns `{remote, bytes}` fields that land in
 * `result.remote`/`result.bytes` with the correct units.
 */

/** p-th percentile of a numeric sample (nearest-rank). */
export const percentile = (sorted, p) => {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, idx)];
};

/**
 * Stats object for one array of samples. `dist` carries the full sorted
 * sample array (rounded) so artifacts hold the real distribution, not just
 * summary points — distributions are required for the WU5 baseline.
 */
export const statsOf = (arr, { warmup = 0, unit = 'ms' } = {}) => {
	const s = [...arr].sort((a, b) => a - b);
	const sum = arr.reduce((a, b) => a + b, 0);
	return {
		samples: arr.length,
		warmup,
		unit,
		mean: +(sum / arr.length).toFixed(4),
		p50: +percentile(s, 50).toFixed(4),
		p95: +percentile(s, 95).toFixed(4),
		min: +s[0].toFixed(4),
		max: +s[s.length - 1].toFixed(4),
		dist: s.map((v) => +v.toFixed(4))
	};
};

/**
 * Run `fn` for `warmup` + `samples` iterations, return timing stats for the
 * synchronous call (`local`). `fn(i)` may return an object with explicit
 * per-iteration sub-measurements:
 *
 *   `{ remote: <ms number> }` → collected as `result.remote` (timing stats)
 *   `{ bytes: <byte count> }` → collected as `result.bytes` (BYTE stats —
 *                               never a timing field)
 *
 * A bare numeric return is treated as `remote` ONLY for backwards
 * compatibility of timing-only callbacks; byte counts must use `{bytes}`.
 */
export const measure = (fn, { warmup = 3, samples = 40 } = {}) => {
	for (let i = 0; i < warmup; i++) fn(-1 - i);
	const local = [];
	const remote = [];
	const bytes = [];
	for (let i = 0; i < samples; i++) {
		const t0 = performance.now();
		const r = fn(i);
		local.push(performance.now() - t0);
		if (typeof r === 'number') remote.push(r);
		else if (r != null && typeof r === 'object') {
			if (typeof r.remote === 'number') remote.push(r.remote);
			if (typeof r.bytes === 'number') bytes.push(r.bytes);
		}
	}
	const out = statsOf(local, { warmup });
	if (remote.length) out.remote = statsOf(remote, { warmup });
	if (bytes.length) out.bytes = statsOf(bytes, { warmup, unit: 'bytes' });
	return out;
};

/** Time one synchronous call once. */
export const once = (fn) => {
	const t0 = performance.now();
	const out = fn();
	return { ms: +(performance.now() - t0).toFixed(4), out };
};
