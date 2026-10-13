<script lang="ts">
	import {
	Edytor,
	createColumnsPlugin,
	createMarkdownShortcutsPlugin,
	richTextPlaceholder,
	type Uploader,
	type EdytorInstance
} from 'edytor';
	import { demoDocument } from './demo-document';
	// The demo's chrome (the package draws none), copied by scripts/pack-edytor.sh.
	import {
		blockHandlesPlugin,
		blockMenuPlugin,
		codePlugin,
		image,
		marquee,
		richTextPlugin,
		slashMenuPlugin,
		suggestionsPlugin,
		tablePlugin,
		toolbarPlugin
	} from '../chrome/plugins';
	import 'edytor/themes/notion.css';
	import './live-editor.css';
	import { aiDemoPlugin, askAI } from './ai-demo';

	/** The public demo room (site/room): one shared document per UTC day. */
	const SERVER = 'wss://edytor-room.beynar.workers.dev/rooms';
	/**
	 * The server render (prerendered at build time) shows the seed as a read-only
	 * snapshot and opens nothing, so what depends on the browser (today's room,
	 * the guest id, a random name) is read only there; the room's label shows
	 * once mounted, so the server and hydrated markup agree.
	 */
	const browser = typeof window !== 'undefined';
	const room = browser ? `demo-${new Date().toISOString().slice(0, 10)}` : 'demo';
	let roomLabel = $state('');
	$effect(() => {
		roomLabel = room;
	});

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

	const guest = browser ? guestId() : 'server';
	/** The actor id is the user id the demo room's `authorize` gives this guest (`guest:<id>`). */
	const actor = { id: `guest:${guest}`, name: `${pick(NAMES)} (guest)`, color: pick(COLORS) };
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

	// Rich text, block moves and the suggestion keys are defaults (listed here with
	// the demo's chrome); images, columns, tables and the marquee are opt-in. A drag from the
	// frame's margin selects blocks.
	/**
	 * A dropped or pasted image goes into the shared page itself, as a `data:` URL
	 * every visitor of the room sees (the demo has no file storage), shown at once
	 * from the file while it is read; a larger file is refused. Only the image
	 * plugin takes files here.
	 */
	const MAX_IMAGE = 200 * 1024;
	const inlineImage: Uploader = (file, report) =>
		new Promise((resolve, reject) => {
			if (!file.type.startsWith('image/') || file.size > MAX_IMAGE)
				return reject(new Error('The demo takes images up to 200 KB.'));
			const reader = new FileReader();
			reader.onload = () => {
				report.progress(1);
				resolve(String(reader.result));
			};
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(file);
		});

	const plugins = [
		aiDemoPlugin,
		blockHandlesPlugin,
		blockMenuPlugin,
		codePlugin,
		createColumnsPlugin(),
		tablePlugin,
		marquee({ container: '.live-editor' }),
		createMarkdownShortcutsPlugin(),
		slashMenuPlugin,
		toolbarPlugin,
		suggestionsPlugin,
		image({ upload: inlineImage }),
		richTextPlugin
	];
</script>

<div class="live-editor-frame edytor-notion">
	<div class="live-editor-bar">
		<span class="live-crumb">🌱 Edit this page with everyone</span>
		<span class="live-room" title="One shared page per day">{roomLabel}</span>
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
		<button
			type="button"
			class="live-ai"
			title="A canned AI draft, shown only to you until you accept it"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => edytor && askAI(edytor)}>✦ Ask AI</button
		>
	</div>
	<div class="live-editor">
		<Edytor
			bind:edytor
			value={demoDocument}
			snapshot={demoDocument}
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
	.live-ai {
		height: 28px;
		padding: 0 10px;
		border: 0;
		border-radius: 6px;
		background: rgba(35, 131, 226, 0.08);
		color: #2383e2;
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
	}
	.live-ai:hover {
		background: rgba(35, 131, 226, 0.16);
	}
	/* The page grows with its content, up to twice the viewport's height, then scrolls. */
	.live-editor {
		max-height: 200vh;
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
