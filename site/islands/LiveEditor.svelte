<script lang="ts" module>
	// Client only: the editor measures the DOM and opens a socket.
	export const client = 'only';
</script>

<script lang="ts">
	import {
		Edytor,
		arrowMovePlugin,
		blockMenuPlugin,
		codePlugin,
		markdownShortcutsPlugin,
		richTextPlugin,
		richTextPlaceholder,
		slashMenuPlugin,
		toolbarPlugin,
		type EdytorInstance,
		type JSONDoc
	} from 'edytor';
	import 'edytor/themes/notion.css';
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
				data: { icon: '💡' },
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
	/** Everyone here, from presence: Notion's avatar stack. */
	let people = $state<Array<{ id: number; name: string; color: string }>>([]);
	$effect(() => {
		const awareness = edytor?.document.awareness;
		if (!awareness) return;
		const read = () =>
			(people = [...awareness.getStates()].map(([id, state]) => ({
				id,
				name: String(state.user?.name ?? 'Guest'),
				color: String(state.user?.color ?? '#a19e99')
			})));
		read();
		awareness.on('change', read);
		return () => awareness.off('change', read);
	});

	const plugins = [
		arrowMovePlugin,
		blockMenuPlugin,
		codePlugin,
		markdownShortcutsPlugin,
		slashMenuPlugin,
		toolbarPlugin,
		richTextPlugin
	];
</script>

<div class="live-editor-frame edytor-notion">
	<div class="live-editor-bar">
		<span class="live-crumb">🌱 Edit this page with everyone</span>
		<span class="live-room" title="One shared page per day">{room}</span>
		<span class="live-people">
			{#each people.slice(0, 5) as person (person.id)}
				<span class="live-avatar" style:background={person.color} title={person.name}
					>{person.name.slice(0, 1)}</span
				>
			{/each}
		</span>
		<span class="live-count"
			>Live · {Math.max(1, people.length)} {people.length > 1 ? 'people' : 'person'} editing</span
		>
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
			placeholder={richTextPlaceholder}
		/>
	</div>
</div>

<style>
	.live-editor-frame {
		overflow: hidden;
		border-radius: 1.25rem;
		background: #fff;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.06),
			0 12px 40px -12px rgb(0 0 0 / 0.18);
		text-align: left;
	}
	.live-editor-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		height: 44px;
		padding: 0 12px 0 16px;
		font-size: 14px;
		color: #2c2c2b;
	}
	.live-crumb {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.live-room {
		color: #a19e99;
		font-size: 12px;
	}
	.live-people {
		display: flex;
		margin-left: auto;
		padding-left: 5px;
	}
	.live-avatar {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		margin-left: -5px;
		border-radius: 999px;
		box-shadow: 0 0 0 2px #fff;
		color: #fff;
		font-size: 11px;
		font-weight: 600;
	}
	.live-count {
		color: #a19e99;
		white-space: nowrap;
	}
	.live-editor {
		max-height: 36rem;
		overflow-y: auto;
		padding: 36px 56px 40px 72px;
	}
	@media (max-width: 640px) {
		.live-room,
		.live-crumb {
			display: none;
		}
		.live-editor {
			padding: 20px 16px 24px 52px;
		}
	}
</style>
