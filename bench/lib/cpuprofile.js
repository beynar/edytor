/**
 * U0 — CPU profile capture + summarizer for `bench/browser.js`.
 *
 * Uses CDP `Profiler.start/stop` (Playwright CDPSession) — ~1ms sampling,
 * ~1000 samples over a diag run. Profiles are DIAGNOSTIC: they attribute
 * wall time to JS functions, they are not additive to the timing lanes.
 *
 * `summarizeProfile` buckets sample timestamps into record windows
 * ([startMs, endMs] on the page's `performance.now()` clock — CDP sample
 * timestamps are CLOCK_MONOTONIC µs, same epoch as performance.now) and
 * reports per-window self-time leaders plus a whole-profile rollup.
 *
 * Function identity: `functionName || '(anonymous)'` +
 * `url basename:line` — stable enough for "who owns this ms" answers.
 */

/** @param {import('playwright').CDPSession} cdp */
export const startCpuProfile = async (cdp) => {
	await cdp.send('Profiler.enable');
	await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
	await cdp.send('Profiler.start');
};

/**
 * Stops profiling. Returns the raw profile — caller decides whether to
 * persist it (profiles can be several MB; keep them out of the JSON
 * artifact, write to .artifacts/).
 */
export const stopCpuProfile = async (cdp) => {
	const { profile } = await cdp.send('Profiler.stop');
	return profile;
};

const fnLabel = (node) => {
	const f = node.callFrame;
	const fn = f.functionName || '(anonymous)';
	const file = (f.url || '').split('/').pop() || '(native)';
	return `${fn} @ ${file}:${f.lineNumber + 1}`;
};

const parseTs = (profile) => {
	// CDP: timestamps in µs. performance.now() is ms on the same clock.
	const t0 = profile.startTime / 1000;
	const t1 = profile.endTime / 1000;
	return { t0, t1 };
};

/**
 * @param {object} profile  raw CDP Profiler profile
 * @param {Array<{start:number,end:number,label:string}>} windows
 *        record windows on the page perf-now clock (ms)
 */
export const summarizeProfile = (profile, windows = []) => {
	const nodes = profile.nodes ?? [];
	const byId = new Map(nodes.map((n) => n.id).map((id, i) => [id, i]));
	const samples = profile.samples ?? [];
	const deltas = profile.timeDeltas ?? [];
	const { t0, t1 } = parseTs(profile);

	// Rebuild sample timestamps: startTime + cumulative deltas.
	const ts = new Array(samples.length);
	let acc = t0;
	for (let i = 0; i < samples.length; i++) {
		acc += (deltas[i] ?? 0) / 1000;
		ts[i] = acc;
	}

	// Self-time per node for a sample index list.
	const selfTime = (idxs) => {
		const agg = new Map(); // nodeIndex → µs-ish ms
		for (const i of idxs) {
			const ni = byId.get(samples[i]);
			if (ni === undefined) continue;
			const dt = i + 1 < ts.length ? ts[i + 1] - ts[i] : 1;
			agg.set(ni, (agg.get(ni) ?? 0) + dt);
		}
		return agg;
	};

	const top = (agg, n = 15) =>
		[...agg.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, n)
			.map(([ni, ms]) => ({
				fn: fnLabel(nodes[ni]),
				selfMs: +ms.toFixed(2),
				url: nodes[ni].callFrame.url ? undefined : '(native)'
			}))
			.map(({ fn, selfMs }) => ({ fn, selfMs }));

	const all = selfTime(samples.map((_, i) => i));
	const total = {
		durationMs: +(t1 - t0).toFixed(1),
		samples: samples.length,
		avgIntervalUs: samples.length ? +(((t1 - t0) * 1000) / samples.length).toFixed(0) : null,
		topSelf: top(all)
	};

	const perWindow = windows.map((w) => {
		const idxs = [];
		for (let i = 0; i < ts.length; i++) if (ts[i] >= w.start && ts[i] <= w.end) idxs.push(i);
		const agg = selfTime(idxs);
		return {
			label: w.label,
			windowMs: +(w.end - w.start).toFixed(2),
			samples: idxs.length,
			topSelf: top(agg, 8)
		};
	});

	return { total, windows: perWindow };
};
