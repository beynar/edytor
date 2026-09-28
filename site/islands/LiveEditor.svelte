<script lang="ts" module>
	// Client only: the editor measures the DOM and opens a socket.
	export const client = 'only';
</script>

<script lang="ts">
	import {
		Edytor,
		arrowMovePlugin,
		codePlugin,
		markdownShortcutsPlugin,
		richTextPlugin,
		slashMenuPlugin,
		toolbarPlugin,
		type EdytorInstance,
		type JSONDoc
	} from 'edytor';
	import './live-editor.css';

	/** The public demo room (site/room): one shared document per UTC day. */
	const SERVER = 'wss://edytor-room.beynar.workers.dev/rooms';
	const room = `demo-${new Date().toISOString().slice(0, 10)}`;

	const NAMES = ['Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Tim', 'Barbara', 'Dennis', 'Radia', 'Ken'];
	const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
	const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;

	/** A stable guest id per browser: the room binds this browser's edits to it. */
	const guestId = () => {
		try {
			const saved = localStorage.getItem('edytor-demo-guest');
			if (saved) return saved;
			const id = crypto.randomUUID();
			localStorage.setItem('edytor-demo-guest', id);
			return id;
		} catch {
			return crypto.randomUUID();
		}
	};

	const value: JSONDoc = {
		children: [
			{ id: 'hello', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Edit this page with everyone' }] },
			{
				id: 'intro',
				type: 'paragraph',
				content: [
					{ text: 'This document is live. Open this page in another tab or send it to a friend: ' },
					{ text: 'every keystroke syncs', marks: { bold: true } },
					{ text: ' through a Cloudflare Durable Object, and it resets every day.' }
				]
			},
			{
				id: 'tip',
				type: 'callout',
				data: { icon: '✦' },
				content: [
					{ text: 'Type ' },
					{ text: '/', marks: { code: true } },
					{ text: ' for blocks, select text to format it, and drag the six-dot handle to move or nest a block.' }
				]
			},
			{ id: 'todo-1', type: 'todo-item', data: { checked: true }, content: [{ text: 'Collaborative by default' }] },
			{ id: 'todo-2', type: 'todo-item', data: { checked: false }, content: [{ text: 'Works offline, syncs when you are back' }] },
			{ id: 'quote', type: 'quote', content: [{ text: 'Your words stay yours, even as the page changes.' }] },
			{
				id: 'code',
				type: 'code',
				content: [{ text: '' }],
				children: [{ id: 'code-line', type: 'codeLine', content: [{ text: 'const editor = "yours to shape";' }] }]
			},
			{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
		]
	};

	const guest = guestId();
	const actor = { id: guest, name: `${pick(NAMES)} (guest)`, color: pick(COLORS) };
	let edytor = $state<EdytorInstance>();
	let people = $state(1);
	$effect(() => {
		const awareness = edytor?.document.awareness;
		if (!awareness) return;
		const count = () => (people = Math.max(1, awareness.getStates().size));
		count();
		awareness.on('change', count);
		return () => awareness.off('change', count);
	});

	const plugins = [
		arrowMovePlugin,
		codePlugin,
		markdownShortcutsPlugin,
		slashMenuPlugin,
		toolbarPlugin,
		richTextPlugin
	];
</script>

<div class="live-editor-frame">
	<div class="live-editor-bar">
		<span class="live-dot"></span>
		<span>Live · {people} {people === 1 ? 'person' : 'people'} editing</span>
		<span class="live-room">{room}</span>
	</div>
	<div class="live-editor">
		<Edytor
			bind:edytor
			{value}
			{actor}
			server={SERVER}
			{room}
			params={{ guest }}
			{plugins}
			placeholder={(view) => (view.focused ? "Type '/' for commands" : null)} />
	</div>
</div>

<style>
	.live-editor-frame {
		overflow: hidden;
		border-radius: 1.25rem;
		background: #fff;
		color: #37352f;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.06),
			0 12px 40px -12px rgb(0 0 0 / 0.18);
		text-align: left;
	}
	.live-editor-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1.25rem;
		border-bottom: 1px solid #efeee9;
		font-size: 0.8rem;
		color: #787774;
	}
	.live-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 999px;
		background: #16a34a;
		box-shadow: 0 0 0 3px rgb(22 163 74 / 0.18);
	}
	.live-room {
		margin-left: auto;
		font-family: ui-monospace, monospace;
		font-size: 0.75rem;
		color: #b6b4af;
	}
	.live-editor {
		padding: 2rem 2.5rem 1.5rem 3.5rem;
		max-height: 34rem;
		overflow-y: auto;
		font-family:
			ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			sans-serif;
	}
	@media (max-width: 640px) {
		.live-editor {
			padding: 1.25rem 1rem 1rem 2.25rem;
		}
	}
</style>
