#!/usr/bin/env node
/**
 * The room soak and fault harness (WU-16). Dev-only; never shipped.
 *
 *   node bench/soak/run.mjs [--clients 50] [--minutes 20] [--threads 5]
 *     [--ops 0.4] [--presence 20] [--churn 1] [--offline 2] [--reload 0.1]
 *     [--faults on|off] [--seed 1] [--port 4530]
 *     [--server https://staging.example/rooms --token <SOAK_TOKEN>]
 *     [--room soak-<time>] [--out bench/results/soak-<time>.json]
 *
 * Without `--server` it starts the room locally (`server.mjs`: Miniflare,
 * the shipped `edytor/cloudflare` room as `SoakRoom`). `--clients` headless
 * documents on the shipped `WebsocketProvider`, spread over `--threads`
 * worker threads (`clients.mjs`), edit one document: `--ops` edits a
 * second each (typing, Backspace, Enter, merges, moves, marks, data, cuts),
 * presence after each edit and at `--presence` Hz while dragging a
 * selection (`--drag` of the time; `--drag 1`: every client at that rate), `--churn` dropped sockets a minute each,
 * `--offline` offline sessions (10–60 s, still editing) an hour each, a
 * `--reload` share of the churn as page loads (a new replica). Every run
 * also forces one offline session (the first client, a quarter into the
 * run, for up to 20 s) and one reload (the last client, at 40 %), so a
 * short run replays and reloads too; the run fails when either did not
 * happen.
 *
 * Faults (`--faults on`), on a fixed schedule: a forced compaction every
 * 90 s (timed), a storage fault (every update append fails) for 2 s every
 * 5 min, a failing compaction for 30 s every 8 min, an abort
 * (`ctx.abort()`) every 7 min, and, locally only, a hibernation (the
 * instance's memory dropped, its sockets kept) every 4 min and an eviction
 * with the sockets closed every 6 min.
 *
 * Measured: the ack latency of every edit outside an offline session (edit
 * → the room's `messageSaved` covering it; edits made while the socket was
 * down or not yet synced are also reported apart), the replay time of
 * offline sessions, the
 * room's `metrics()` (document and stored bytes, records, sockets,
 * compactions, folds, fan-out, refusals), the isolate heap (locally,
 * through workerd's inspector) and workerd's RSS, the clients' event-loop
 * delay. At the end every client comes online and settles; convergence
 * holds when every client's JSON, the room's own `read()` and a fresh
 * joiner's are equal — then again after the room is evicted (what it
 * stored). Last, the final document's stored size is measured against a
 * fresh seed of its JSON and its purge at a horizon of now (`size.mjs`).
 *
 * Operator routes carry the token in an `Authorization: Bearer` header;
 * sockets carry it as `?token=` (a WebSocket sets no header).
 */
import { Worker } from 'node:worker_threads';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { loadavg } from 'node:os';
import { loadEngine } from './engine.mjs';
import { seedValue } from './edits.mjs';
import { measure } from './size.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	if (at === -1) return fallback;
	const value = args[at + 1];
	return typeof fallback === 'number' ? Number(value) : value;
};

const config = {
	clients: option('clients', 50),
	minutes: option('minutes', 20),
	threads: option('threads', 5),
	opsPerSecond: option('ops', 0.4),
	presenceHz: option('presence', 20),
	/** The share of its time a client drags a selection (presence at `presenceHz`); 1: always. */
	dragShare: option('drag', 0.1),
	churnPerMinute: option('churn', 1),
	offlinePerHour: option('offline', 2),
	reloadShare: option('reload', 0.1),
	faults: option('faults', 'on') !== 'off',
	seed: option('seed', 1),
	port: option('port', 4530),
	maxBlocks: option('max-blocks', 400),
	maxChars: option('max-chars', 60_000),
	sampleSeconds: option('sample', 10),
	/** The fault schedule's times, scaled (a short smoke run: `--fault-scale 0.1`). */
	faultScale: option('fault-scale', 1)
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const roomName = option('room', `soak-${stamp}`);
const token = option('token', '');
const out = option('out', fileURLToPath(new URL(`../results/soak-${stamp}.json`, import.meta.url)));

const local = option('server', '') === '';
let room = null;
if (local) {
	const { startSoakRoom } = await import('./server.mjs');
	room = await startSoakRoom({ port: config.port, inspectorPort: config.port + 1 });
}
const httpBase = local
	? room.url
	: option('server')
			.replace(/^ws/, 'http')
			.replace(/\/rooms\/?$/, '');
const server = `${httpBase.replace(/^http/, 'ws')}/rooms`;
const routeOf = (action, query = '') => {
	const tail = query ? `?${query}` : '';
	return `${httpBase}/rooms/${encodeURIComponent(roomName)}/${action}${tail}`;
};
const call = async (action, { method = 'GET', query = '' } = {}) => {
	const started = performance.now();
	try {
		const headers = token ? { authorization: `Bearer ${token}` } : {};
		const response = await fetch(routeOf(action, query), { method, headers });
		const body = response.headers.get('content-type')?.includes('json')
			? await response.json()
			: await response.text();
		return { ok: response.ok, status: response.status, body, ms: performance.now() - started };
	} catch (error) {
		return { ok: false, error: String(error), ms: performance.now() - started };
	}
};

const log = (...line) =>
	console.log(`[${((performance.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...line);
const t0 = performance.now();
const wallStart = Date.now();
log(`room ${roomName} on ${server}`, JSON.stringify(config));

// ── Seed: one writer seeds the document and leaves once the room stored it ──
const engine = await loadEngine();
const { E, crdt } = engine;
const until = async (check, timeoutMs, what) => {
	const deadline = performance.now() + timeoutMs;
	while (!check()) {
		if (performance.now() > deadline) throw new Error(`timed out: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};
/** A replica that syncs from nothing (or from `value`), and its provider. */
const join = async (user, value) => {
	const document = E.createDocument({ value, actor: { id: user }, semantics: E.defaultSemantics });
	const provider = new crdt.providers.WebsocketProvider(server, roomName, document.doc, {
		params: { user, ...(token ? { token } : {}) },
		disableBc: true
	});
	await until(() => provider.synced && provider.saved, 60_000, `${user} synced`);
	return { document, provider, close: () => (provider.destroy(), document.destroy()) };
};
(await join('seeder', seedValue())).close();
log('seeded');

// ── Clients ──
const threads = [];
const per = Math.ceil(config.clients / config.threads);
for (let t = 0, first = 0; first < config.clients; t++, first += per) {
	const worker = new Worker(new URL('./clients.mjs', import.meta.url), {
		workerData: {
			...config,
			first,
			count: Math.min(per, config.clients - first),
			server,
			room: roomName,
			token
		}
	});
	const inbox = [];
	const waiters = [];
	worker.on('message', (message) => {
		const waiter = waiters.findIndex((w) => w.type === message.type);
		if (waiter === -1) inbox.push(message);
		else waiters.splice(waiter, 1)[0].resolve(message);
	});
	worker.on('error', (error) => {
		console.error('client thread failed', error);
		process.exitCode = 1;
	});
	const next = (type) =>
		new Promise((resolve) => {
			const at = inbox.findIndex((m) => m.type === type);
			if (at !== -1) return resolve(inbox.splice(at, 1)[0]);
			waiters.push({ type, resolve });
		});
	threads.push({ worker, next, ask: (message, type) => (worker.postMessage(message), next(type)) });
}
await Promise.all(threads.map((t) => t.next('loaded')));
const ready = await Promise.all(threads.map((t) => t.ask({ type: 'ready' }, 'ready')));
log(`clients joined (${ready.every((r) => r.ok) ? 'all synced' : 'NOT all synced'})`);

// ── Measurement ──
const acks = [];
const acksDisconnected = [];
const replays = [];
const samples = [];
const faults = [];
const errors = [];
const totals = { ops: {}, closes: {}, events: {}, reloads: 0, churns: 0, offline: 0 };
/** The newest metrics of each room instance (by start time: a wake starts them again), and its log. */
const instances = new Map();
/** The object's starts (`{ at, sockets }`: a wake from hibernation finds its sockets). */
let starts = [];
const roomLog = new Map();
const add = (into, from) => {
	for (const [key, n] of Object.entries(from)) into[key] = (into[key] ?? 0) + n;
};
const pct = (sorted, p) =>
	sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
const summary = (values) => {
	const sorted = Float64Array.from(values).sort();
	const r = (v) => (v === null ? null : Math.round(v * 10) / 10);
	return {
		count: sorted.length,
		p50: r(pct(sorted, 50)),
		p90: r(pct(sorted, 90)),
		p99: r(pct(sorted, 99)),
		p999: r(pct(sorted, 99.9)),
		max: r(sorted.length ? sorted[sorted.length - 1] : null)
	};
};

const sample = async (gc = false) => {
	const window = await Promise.all(threads.map((t) => t.ask({ type: 'stats', gc }, 'stats')));
	const windowAcks = [];
	let online = 0;
	let loopP99 = 0;
	let clientHeap = 0;
	for (const { stats } of window) {
		for (const ms of stats.acks) windowAcks.push(ms);
		acksDisconnected.push(...stats.acksDisconnected);
		replays.push(...stats.replays);
		errors.push(...stats.errors);
		add(totals.ops, stats.ops);
		add(totals.closes, stats.closes);
		add(totals.events, stats.events);
		totals.reloads += stats.reloads;
		totals.churns += stats.churns;
		totals.offline += stats.offline;
		online += stats.online;
		loopP99 = Math.max(loopP99, stats.loopP99);
		clientHeap += stats.heapUsed;
	}
	acks.push(...windowAcks);
	const metrics = await call('metrics');
	const heap = room ? await room.heap(gc) : null;
	const rss = room ? room.rss() : null;
	const cpu = room ? room.cpu() : null;
	const m = metrics.body?.metrics;
	if (metrics.body?.starts) starts = metrics.body.starts;
	if (m) {
		instances.set(m.since, m);
		for (const entry of metrics.body.log ?? []) roomLog.set(`${m.since}:${entry.n}`, entry);
	}
	const row = {
		t: Math.round((performance.now() - t0) / 1000),
		online,
		acks: summary(windowAcks),
		heapUsed: heap?.usedSize ?? null,
		heapTotal: heap?.totalSize ?? null,
		gc,
		rss,
		cpu,
		clientHeap,
		clientRss: process.memoryUsage().rss,
		clientLoopP99: Math.round(loopP99),
		documentBytes: m?.documentBytes,
		storedBytes: m?.storedBytes,
		records: m?.records,
		updateRecords: m?.updateRecords,
		sockets: m?.sockets,
		compactions: m?.compaction?.count,
		compactionMaxMs: m?.compaction?.maxMs,
		folds: m?.fold?.count,
		foldMaxMs: m?.fold?.maxMs,
		fanOut: m?.fanOut?.messages,
		refusals: m?.refusals,
		quotaHits: m?.quotaHits,
		failure: metrics.body?.failure ?? null,
		since: m?.since,
		load: loadavg()[0]
	};
	samples.push(row);
	const mb = (b) => (b == null ? '-' : `${(b / 1048576).toFixed(1)}MB`);
	log(
		`online ${online}/${config.clients} · ack p50 ${row.acks.p50 ?? '-'} p99 ${row.acks.p99 ?? '-'} ms (${row.acks.count}) · heap ${mb(row.heapUsed)}${gc ? ' (gc)' : ''} rss ${mb(rss)} cpu ${cpu ?? '-'}% · doc ${mb(row.documentBytes)} stored ${mb(row.storedBytes)} · records ${row.records} · sockets ${row.sockets} · compactions ${row.compactions} · clients heap ${mb(clientHeap)} rss ${mb(row.clientRss)} loop p99 ${row.clientLoopP99} ms · load ${row.load.toFixed(0)}`
	);
	return row;
};

// ── Faults ──
const schedule = config.faults
	? [
			{ every: 90, at: 45, name: 'compaction', run: () => call('compact', { method: 'POST' }) },
			{
				every: 300,
				at: 150,
				name: 'storage-append',
				run: async () => {
					const on = await call('fault', { method: 'POST', query: 'kind=append&on=1' });
					await new Promise((resolve) => setTimeout(resolve, 2000));
					const off = await call('fault', { method: 'POST', query: 'kind=append&on=0' });
					return { ok: on.ok && off.ok, on: on.body, off: off.body };
				}
			},
			{
				every: 480,
				at: 400,
				name: 'storage-compaction',
				run: async () => {
					const on = await call('fault', { method: 'POST', query: 'kind=compaction&on=1' });
					const forced = await call('compact', { method: 'POST' });
					await new Promise((resolve) => setTimeout(resolve, 30_000));
					const off = await call('fault', { method: 'POST', query: 'kind=compaction&on=0' });
					return { ok: on.ok && off.ok, forced: { status: forced.status, body: forced.body } };
				}
			},
			{ every: 420, at: 300, name: 'abort', run: () => call('abort', { method: 'POST' }) },
			...(local
				? [
						{
							every: 240,
							at: 120,
							name: 'hibernate',
							run: () => call('evict', { method: 'POST' })
						},
						{
							every: 360,
							at: 200,
							name: 'evict',
							run: () => call('evict', { method: 'POST', query: 'sockets=close' })
						}
					]
				: [])
		]
	: [];

const runFault = async (fault) => {
	const result = await fault.run();
	const entry = {
		t: Math.round((performance.now() - t0) / 1000),
		fault: fault.name,
		ms: Math.round(result.ms ?? 0),
		result: result.body ?? result
	};
	faults.push(entry);
	log(`fault ${fault.name}: ${JSON.stringify(entry.result).slice(0, 160)} (${entry.ms} ms)`);
};

// ── Forced disturbances: one offline session and one reload in every run ──
const threadOf = (index) => threads[Math.floor(index / per)];
const forced = [];
const runMs = config.minutes * 60_000;
const disturbances = [
	{ at: runMs / 4, what: 'offline', client: 0, ms: Math.min(20_000, runMs / 6) },
	{ at: runMs * 0.4, what: 'reload', client: config.clients - 1 }
];
const disturb = async ({ what, client, ms }) => {
	const answer = await threadOf(client).ask({ type: 'disturb', what, client, ms }, 'disturbed');
	forced.push({ what, client, ms, done: answer.done });
	log(`forced ${what} of u${client}: ${answer.done ? 'done' : 'NOT done'}`);
};

// ── The run ──
await Promise.all(threads.map((t) => t.worker.postMessage({ type: 'start' })));
const started = performance.now();
const end = started + runMs;
const due = schedule.map((f) => ({ fault: f, next: started + f.at * 1000 * config.faultScale }));
const pendingDisturbances = disturbances.map((d) => ({ ...d, at: started + d.at }));
let nextSample = started + config.sampleSeconds * 1000;
let samplesTaken = 0;
const inFlight = new Set();
while (performance.now() < end) {
	const now = performance.now();
	for (const d of due) {
		if (now >= d.next) {
			d.next += d.fault.every * 1000 * config.faultScale;
			const p = runFault(d.fault).finally(() => inFlight.delete(p));
			inFlight.add(p);
		}
	}
	while (pendingDisturbances.length && now >= pendingDisturbances[0].at) {
		const p = disturb(pendingDisturbances.shift()).finally(() => inFlight.delete(p));
		inFlight.add(p);
	}
	if (now >= nextSample) {
		nextSample += config.sampleSeconds * 1000;
		await sample(++samplesTaken % 6 === 0);
	}
	await new Promise((resolve) => setTimeout(resolve, 200));
}
await Promise.all(inFlight);
await call('fault', { method: 'POST', query: 'kind=append&on=0' });
await call('fault', { method: 'POST', query: 'kind=compaction&on=0' });
log('load stopped; settling');

// ── Convergence ──
const settled = await Promise.all(
	threads.map((t) => t.ask({ type: 'settle', timeoutMs: 180_000 }, 'settled'))
);
const stuck = settled.flatMap((s) => s.ok);
await sample(true);
log(stuck.length ? `NOT settled: ${stuck.join(', ')}` : 'every client synced and saved');

/** Every client's snapshot, once their state vectors agree (they still receive the last relays). */
const snapshots = async () => {
	const deadline = performance.now() + 120_000;
	for (;;) {
		const all = (
			await Promise.all(threads.map((t) => t.ask({ type: 'snapshot' }, 'snapshot')))
		).flatMap((s) => s.clients);
		const vectors = new Set(all.map((c) => JSON.stringify(c.sv)));
		if (vectors.size === 1 || performance.now() > deadline) return { all, vectors: vectors.size };
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
};
const { all, vectors } = await snapshots();
/** The isolate's live heap (after a full GC), quiet: every client connected and idle. */
const heapNow = async () => {
	await new Promise((resolve) => setTimeout(resolve, 5000));
	const heap = room ? await room.heap(true) : null;
	const metrics = (await call('metrics')).body?.metrics;
	return heap && { heapMB: heap.usedSize / 1048576, documentBytes: metrics?.documentBytes };
};
const quietHeap = await heapNow();
const jsons = new Map();
for (const c of all) jsons.set(c.json, [...(jsons.get(c.json) ?? []), c.user]);
const reference = all[0].json;
const roomJson = JSON.stringify((await call('json')).body);
const joiner = await join('joiner');
const joinerJson = JSON.stringify(joiner.document.facade.toJSON());
/** What the stored size is made of: a fresh seed of the same JSON, a purge at a horizon of now. */
const size = measure(engine, joiner.document.encode());
joiner.close();
let storedJson = null;
let coldHeap = null;
if (local) {
	await call('evict', { method: 'POST', query: 'sockets=close' });
	const fresh = await join('after-evict');
	storedJson = JSON.stringify(fresh.document.facade.toJSON());
	// The object loaded again from its rows while every client redials and catches up.
	coldHeap = await heapNow();
	fresh.close();
}
const finalCompaction = await call('compact', { method: 'POST' });
const final = await call('metrics');
if (final.body?.metrics) {
	instances.set(final.body.metrics.since, final.body.metrics);
	for (const entry of final.body.log ?? [])
		roomLog.set(`${final.body.metrics.since}:${entry.n}`, entry);
}
const convergence = {
	clients: all.length,
	stateVectors: vectors,
	distinctJson: jsons.size,
	room: roomJson === reference,
	joiner: joinerJson === reference,
	afterEviction: storedJson === null ? null : storedJson === reference,
	blocks: JSON.parse(reference).children.length,
	chars: JSON.parse(reference).children.reduce(
		(n, b) => n + (b.content ?? []).reduce((m, p) => m + (p.text?.length ?? 1), 0),
		0
	)
};
convergence.ok =
	convergence.stateVectors === 1 &&
	convergence.distinctJson === 1 &&
	convergence.room &&
	convergence.joiner &&
	convergence.afterEviction !== false &&
	stuck.length === 0;
if (!convergence.ok) {
	const dump = fileURLToPath(new URL(`../results/soak-${stamp}-divergence.json`, import.meta.url));
	writeFileSync(
		dump,
		JSON.stringify(
			{
				groups: [...jsons.values()],
				jsons: [...jsons.keys()],
				roomJson,
				joinerJson,
				storedJson,
				snapshots: all.map(({ json, ...c }) => c)
			},
			null,
			'\t'
		)
	);
	log(`DIVERGENCE: details in ${dump}`);
}

// ── Report ──
const summed = () => {
	const total = {
		compactions: 0,
		folds: 0,
		foldMaxMs: 0,
		fanOutMessages: 0,
		fanOutBytes: 0,
		quotaHits: 0,
		refusals: {}
	};
	for (const m of instances.values()) {
		total.compactions += m.compaction.count;
		total.folds += m.fold.count;
		total.foldMaxMs = Math.max(total.foldMaxMs, m.fold.maxMs);
		total.fanOutMessages += m.fanOut.messages;
		total.fanOutBytes += m.fanOut.bytes;
		total.quotaHits += m.quotaHits;
		add(total.refusals, m.refusals);
	}
	return total;
};
const heapRows = samples.filter((s) => s.heapUsed != null);
/**
 * The 10 s windows clear of faults: none started in the window's last 40 s
 * (70 s for a failing compaction, which lasts 30 s). Their p99s, sorted.
 */
const quiet = samples
	.filter(
		(s) =>
			s.acks.count > 0 &&
			faults.every((f) => !(s.t - (f.fault === 'storage-compaction' ? 70 : 40) < f.t && f.t <= s.t))
	)
	.map((s) => s.acks.p99)
	.sort((a, b) => a - b);
const report = {
	at: new Date().toISOString(),
	roomName,
	server: local ? 'local (Miniflare, bench/soak/server.mjs)' : server,
	config,
	durationMinutes: Math.round(((performance.now() - started) / 60_000) * 10) / 10,
	/** Edits made connected and synced. */
	acks: summary(acks),
	/** Edits made while the socket was down or not yet synced (churn, a fault's redial and backoff), outside offline sessions. */
	acksDisconnected: summary(acksDisconnected),
	/** Every edit outside an offline session. */
	acksOutsideOffline: summary([...acks, ...acksDisconnected]),
	/** The p99 of edits made while connected in 10 s windows clear of faults: the median window and the worst. */
	faultFreeWindows: {
		windows: quiet.length,
		medianP99: quiet.length ? quiet[Math.floor(quiet.length / 2)] : null,
		worstP99: quiet.length ? quiet[quiet.length - 1] : null
	},
	replays: {
		...summary(replays.map((r) => r.ms)),
		sessions: replays.length,
		edits: replays.reduce((n, r) => n + r.edits, 0)
	},
	room: {
		heapMaxMB: heapRows.length ? Math.max(...heapRows.map((s) => s.heapUsed)) / 1048576 : null,
		heapAfterGcMaxMB: heapRows.some((s) => s.gc)
			? Math.max(...heapRows.filter((s) => s.gc).map((s) => s.heapUsed)) / 1048576
			: null,
		rssMaxMB: samples.some((s) => s.rss)
			? Math.max(...samples.map((s) => s.rss ?? 0)) / 1048576
			: null,
		/** Live heap with every client connected and idle, and after an eviction while every client caught up again. */
		quietHeap,
		coldHeap,
		documentBytes: final.body?.metrics?.documentBytes,
		storedBytes: final.body?.metrics?.storedBytes,
		finalCompactionMs: Math.round(finalCompaction.ms),
		forcedCompactionsMs: summary(faults.filter((f) => f.fault === 'compaction').map((f) => f.ms)),
		instances: instances.size,
		starts: (final.body?.starts ?? starts).map((s) => ({
			t: Math.round((s.at - wallStart) / 1000),
			sockets: s.sockets
		})),
		/** Summed over every instance the run saw (each counts from its start). */
		summed: summed(),
		log: {
			compactions: summary(
				[...roomLog.values()].filter((e) => e.edytor === 'compaction').map((e) => e.ms)
			),
			compactionBytesMax: Math.max(
				0,
				...[...roomLog.values()].filter((e) => e.edytor === 'compaction').map((e) => e.bytes)
			),
			faults: [...roomLog.values()].filter((e) => e.edytor === 'fault').length,
			quota: [...roomLog.values()].filter((e) => e.edytor === 'quota')
		},
		metrics: final.body?.metrics
	},
	clients: {
		maxEventLoopP99Ms: Math.max(...samples.map((s) => s.clientLoopP99)),
		maxHeapMB: Math.max(...samples.map((s) => s.clientHeap)) / 1048576,
		/** Every client's heap after a full GC (the samples that ran one), and per client at the end. */
		heapAfterGcMaxMB:
			Math.max(0, ...samples.filter((s) => s.gc).map((s) => s.clientHeap)) / 1048576,
		heapAfterGcPerClientMB: samples.findLast((s) => s.gc).clientHeap / 1048576 / config.clients
	},
	totals,
	faults,
	forced,
	size: {
		...size,
		edits: Object.entries(totals.ops)
			.filter(([key]) => key.endsWith(':applied'))
			.reduce((n, [, count]) => n + count, 0)
	},
	errors: errors.slice(0, 100),
	convergence,
	samples
};
report.size.bytesPerEdit =
	Math.round(((size.stored - size.fresh) / Math.max(1, report.size.edits)) * 10) / 10;
mkdirSync(fileURLToPath(new URL('../results/', import.meta.url)), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, '\t'));
log(`report: ${out}`);
console.log(
	JSON.stringify(
		{
			acks: report.acks,
			acksDisconnected: report.acksDisconnected,
			replays: report.replays,
			room: { ...report.room, metrics: undefined },
			clients: report.clients,
			totals,
			forced,
			size: { ...report.size, census: undefined, censusAfterPurge: undefined },
			convergence
		},
		null,
		2
	)
);

await Promise.all(threads.map((t) => t.ask({ type: 'close' }, 'closed')));
for (const t of threads) await t.worker.terminate();
await room?.dispose();
const forcedOk =
	forced.length === disturbances.length && forced.every((f) => f.done) && replays.length > 0;
if (!forcedOk)
	console.error('a forced offline session or reload did not happen (or nothing replayed)');
process.exit(convergence.ok && forcedOk ? (process.exitCode ?? 0) : 1);
