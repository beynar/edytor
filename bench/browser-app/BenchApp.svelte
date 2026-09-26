<script>
	import { Edytor, richTextPlugin } from 'edytor';
	import * as Y from 'edytor/crdt';
	import { bindDocument, bindEdytorDoc, bindSync } from 'edytor/crdt/edytor';

	// U0: stamp module-eval time before any other script work runs.
	if (window.__BENCH_MOUNT__) window.__BENCH_MOUNT__.appScript = performance.now();

	/**
	 * Deterministic seeded fixtures — driven entirely by URL params so the
	 * bench artifact records the exact shape measured (no RNG):
	 *
	 *   ?fixture=flat&blocks=N&chars=C&marks=0|1
	 *     N flat paragraphs `b0…bN-1`, each `chars` UTF-16 units. `marks=1`
	 *     gives every other block's payload run a bold mark so formatting
	 *     costs are real.
	 *
	 *   ?fixture=shared&chars=C
	 *     ONE paragraph `b0` carrying a C-char formatted backing text
	 *     (200-char runs, alternating bold/italic/bold+italic/plain).
	 *     The driver then `facade.splitBlock`s it into siblings so lanes
	 *     exercise the shared-backing-text ownership shape (the same shape
	 *     the node `rangeReads` lane measures).
	 */
	const params = new URLSearchParams(window.location.search);
	const num = (k, d) => {
		const v = Number(params.get(k));
		return Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
	};
	const fixture = params.get('fixture') ?? 'flat';
	const BLOCKS = num('blocks', 2);
	const CHARS = num('chars', 60);
	const MARKS = params.get('marks') === '1';

	const pad = (i) => 'x'.repeat(Math.max(1, CHARS - `block-${i} `.length));

	const sharedRun = (i) => ({
		text: 'x'.repeat(200),
		marks:
			i % 4 === 0
				? { bold: true }
				: i % 4 === 1
					? { italic: true }
					: i % 4 === 2
						? { bold: true, italic: true }
						: undefined
	});

	const seed =
		fixture === 'shared'
			? {
					children: [
						{
							type: 'paragraph',
							id: 'b0',
							content: Array.from({ length: Math.max(1, Math.ceil(CHARS / 200)) }, (_, i) =>
								sharedRun(i)
							)
						}
					]
				}
			: {
					children: Array.from({ length: BLOCKS }, (_, i) => ({
						type: 'paragraph',
						id: `b${i}`,
						content: MARKS
							? [
									{ text: `block-${i} ` },
									{ text: pad(i), marks: i % 2 === 0 ? { bold: true } : { italic: true } }
								]
							: [{ text: `block-${i} ` + pad(i) }]
					}))
				};

	const plugins = [richTextPlugin];

	/**
	 * U8a — explicit full-value consumer modes (`?consumer=`):
	 *   onchange — `onChange` prop receives the export per commit and
	 *     serializes it (a persistence-layer-shaped consumer).
	 *   derived — a reactive `$derived` reads `edytor.value` (memoized
	 *     export) + serializes on every commit (a reactive-consumer shape).
	 * Both write the observed byte count to `__BENCH_VALUE__` so the
	 * driver can confirm the consumer actually ran each commit.
	 */
	const consumer = params.get('consumer'); // 'onchange' | 'derived' | null

	let edytor = $state();

	const onChange =
		consumer === 'onchange'
			? (v) => {
					window.__BENCH_VALUE__ = { bytes: JSON.stringify(v).length };
				}
			: undefined;

	const derivedValueBytes = $derived.by(() =>
		consumer === 'derived' && edytor ? JSON.stringify(edytor.value).length : 0
	);

	$effect(() => {
		if (consumer === 'derived') window.__BENCH_VALUE__ = { bytes: derivedValueBytes };
	});

	$effect(() => {
		// The bench driver drives lanes through this handle. `Y` is the
		// packed vendored engine (edytor/crdt) for remote-update lanes; `D`
		// (bindDocument) + `seed` let the driver measure the headless
		// document path (createDocument/encode/loadDocument) for comparison
		// against the mounted path — instrumentation only, no product change.
		window.__BENCH__ = {
			edytor,
			Y,
			E: bindEdytorDoc(Y),
			S: bindSync(Y),
			D: bindDocument(Y),
			seed,
			fixture: { fixture, blocks: BLOCKS, chars: CHARS, marks: MARKS, consumer }
		};
		if (window.__BENCH_MOUNT__) window.__BENCH_MOUNT__.benchHandle = performance.now();
	});
</script>

<div data-testid="editable-root">
	<Edytor bind:edytor {plugins} value={seed} {onChange} />
</div>
