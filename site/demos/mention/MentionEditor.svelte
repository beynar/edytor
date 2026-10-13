<script lang="ts">
	import {
		Edytor,
		createMentionPlugin,
		type JSONDoc,
		type MentionItem,
		type Plugin,
		type TriggerMenuController
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	const people: MentionItem[] = [
		{ id: 'u1', label: 'Ada Lovelace', description: 'Engineering' },
		{ id: 'u2', label: 'Alan Turing', description: 'Research' },
		{ id: 'u3', label: 'Grace Hopper', description: 'Compilers' },
		{ id: 'u4', label: 'Katherine Johnson', description: 'Orbits' },
		{ id: 'u5', label: 'Margaret Hamilton', description: 'Flight software' }
	];

	const hues = [12, 45, 150, 200, 280];
	const hueOf = (person: MentionItem) => hues[Number(person.id.slice(1)) % hues.length];

	// People as cards under the caret.
	const mentions = createMentionPlugin({
		items: (query) =>
			people.filter((person) => person.label.toLowerCase().includes(query.trim().toLowerCase())),
		menu
	});
</script>

<!-- A card list: a coloured badge, the name, the team underneath. -->
{#snippet menu(menu: TriggerMenuController<MentionItem>)}
	<div class="cards" onmousedown={(event) => event.preventDefault()} role="presentation">
		<div class="title">Mention a teammate</div>
		<div class="list" aria-label="People" {@attach menu.popup}>
			{#each menu.items as person, index (person.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div
					class="card"
					data-selected={menu.index === index}
					style="--hue: {hueOf(person)}"
					onmousemove={() => (menu.index = index)}
					onclick={() => void menu.pick(person)}
					{@attach menu.option(index)}
				>
					<span class="badge" aria-hidden="true">{person.label.charAt(0)}</span>
					<span class="who">
						<strong>{person.label}</strong>
						<small>{person.description}</small>
					</span>
				</div>
			{:else}
				<div class="empty" role="presentation">
					{menu.loading ? 'Searching…' : 'Nobody by that name'}
				</div>
			{/each}
		</div>
	</div>
{/snippet}

<Edytor {value} plugins={[mentions, ...plugins]} aria-label="Mention demo" />

<style>
	.cards {
		width: 270px;
		padding: 10px;
		border: 1px solid #e3e1dc;
		border-radius: 14px;
		background: #fffdf8;
		box-shadow: 0 12px 30px rgb(60 40 10 / 0.16);
		font: 13px/1.35 system-ui, sans-serif;
		color: #2b2825;
	}
	.title {
		margin: 0 4px 8px;
		color: #8a857c;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.list {
		display: grid;
		gap: 4px;
	}
	.card {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 8px;
		border: 1px solid transparent;
		border-radius: 10px;
		cursor: pointer;
	}
	.card[data-selected='true'] {
		border-color: hsl(var(--hue) 55% 70%);
		background: hsl(var(--hue) 70% 94%);
	}
	.badge {
		display: grid;
		flex: none;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 8px;
		background: hsl(var(--hue) 55% 48%);
		color: #fff;
		font-weight: 700;
	}
	.who {
		display: grid;
	}
	small {
		color: #8a857c;
	}
	.empty {
		padding: 6px 8px;
		color: #8a857c;
	}
</style>
