<script>
	import {
		Edytor,
		richTextPlugin,
		createEquationPlugin,
		createDocument,
		createIndexeddbSync,
		loadDocument
	} from 'edytor';

	// Deterministic ids — the driver asserts block identity, not just text.
	const seed = {
		children: [
			{
				type: 'paragraph',
				id: 'p1',
				content: [{ text: 'packed ' }, { text: 'seed', marks: { bold: true } }]
			},
			{
				type: 'paragraph',
				id: 'p2',
				content: [{ text: 'second block' }]
			}
		]
	};

	const readonlySeed = {
		children: [
			{
				type: 'paragraph',
				id: 'ro1',
				content: [{ text: 'readonly surface' }]
			}
		]
	};

	// The equation plugin's default loads KaTeX from its CDN at first use:
	// the build and the SSR need no `katex` installed (none is, here).
	const plugins = [createEquationPlugin(), richTextPlugin];

	// Shared document — two views on ONE EdytorDocument (U9 headline
	// surface): one facade, one history, one awareness; edits through one
	// view must mirror into the sibling. A real IndexedDB provider is
	// attached through `document.attachSync` (the document-lifetime
	// provider path); the room is unique per run so reruns never hydrate
	// stale rows.
	const sharedSeed = {
		children: [
			{ type: 'paragraph', id: 's1', content: [{ text: 'shared alpha' }] },
			{ type: 'paragraph', id: 's2', content: [{ text: 'shared beta' }] }
		]
	};
	const sharedDocument = createDocument({
		value: sharedSeed,
		actor: { id: 'packed-shared', name: 'Shared' }
	});
	sharedDocument.attachSync(createIndexeddbSync(`packed-shared-${crypto.randomUUID()}`));

	let edytor = $state();
	let readonlyEdytor = $state();
	let sharedA = $state();
	let sharedB = $state();

	$effect(() => {
		window.__EDYTOR_PACKED__ = edytor;
		window.__EDYTOR_PACKED_READONLY__ = readonlyEdytor;
		window.__EDYTOR_PACKED_SHARED__ = {
			document: sharedDocument,
			viewA: sharedA,
			viewB: sharedB,
			loadDocument
		};
	});
</script>

<div data-testid="editable-root">
	<Edytor bind:edytor {plugins} value={seed} />
</div>
<div data-testid="readonly-root">
	<Edytor bind:edytor={readonlyEdytor} {plugins} value={readonlySeed} readonly />
</div>
<div data-testid="shared-a">
	<Edytor bind:edytor={sharedA} {plugins} document={sharedDocument} />
</div>
<div data-testid="shared-b">
	<Edytor bind:edytor={sharedB} {plugins} document={sharedDocument} />
</div>
