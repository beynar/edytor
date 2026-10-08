/** @jsxImportSource ../../jsx */
/**
 * The media kinds (`embed`, `bookmark`, `file`, `video`, `audio`):
 * void blocks following the image pattern (an empty panel until the block
 * has a source, then the media and an editable caption).
 *
 * Security rows (hand-authored, not read from the code):
 * - an embed renders an iframe only for a URL an allowlisted provider
 *   plays, with the provider's player URL (never the stored value), a
 *   `sandbox` without top navigation, modals or downloads, and no `srcdoc`;
 * - every URL a block stores or renders passes the link sanitizer's rules
 *   (`http:`/`https:` with a host; `blob:` for an uploaded media file);
 * - a readonly view of an empty block shows a passive placeholder, so no
 *   viewer can run `upload` or `unfurl`.
 * HTML import maps `iframe`, `video` and `audio` (and the kinds' own
 * `figure` exports) only when the plugin claiming them is listed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	EMBED_PROVIDERS,
	EMBED_SANDBOX,
	createEmbedPlugin,
	embedPlugin,
	embedSourceOf,
	type EmbedProvider
} from '$lib/plugins/media/EmbedPlugin.svelte';
import { createBookmarkPlugin, bookmarkPlugin } from '$lib/plugins/media/BookmarkPlugin.svelte';
import { createFilePlugin } from '$lib/plugins/media/FilePlugin.svelte';
import { videoPlugin, createVideoPlugin } from '$lib/plugins/media/VideoPlugin.svelte';
import { audioPlugin } from '$lib/plugins/media/AudioPlugin.svelte';
import { safeMediaSrc, safeWebUrl } from '$lib/plugins/media/media.js';
import { defaultSemantics } from '$lib/crdt/semantics.js';
import { suggestionsPlugin } from '$lib/plugins/suggestions/suggestionsPlugin.js';
import {
	canonicalTree,
	dispatchClipboardPaste,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const YT = 'dQw4w9WgXcQ';

const mount = async (plugins: Plugin[], children: JSONBlock[], readonly = false) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [...plugins, richTextPlugin], readonly, value: { children } }
	);

/** Type `value` into the empty panel's link field and press Enter. */
const submitLink = async (value: string) => {
	document.querySelector<HTMLButtonElement>('[data-edytor-media-add]')!.click();
	await flushDomUpdates();
	const field = document.querySelector<HTMLInputElement>('[data-edytor-media-form] input')!;
	field.value = value;
	field.dispatchEvent(new Event('input', { bubbles: true }));
	field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	await flushDomUpdates();
};

describe('URL rules (the link sanitizer, http(s) with a host)', () => {
	it('safeWebUrl takes http(s) with a host only', () => {
		expect(safeWebUrl('https://example.com/a')).toBe('https://example.com/a');
		expect(safeWebUrl('  http://example.com ')).toBe('http://example.com');
		for (const bad of [
			'javascript:alert(1)',
			'\u0001javascript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'mailto:a@b.c',
			'/relative/path',
			'example.com',
			'',
			42
		])
			expect(safeWebUrl(bad)).toBeNull();
	});

	it('safeMediaSrc also takes a blob: URL, never data: or a script', () => {
		expect(safeMediaSrc('blob:https://example.com/0f0e')).toBe('blob:https://example.com/0f0e');
		expect(safeMediaSrc('https://cdn.example.com/a.mp4')).toBe('https://cdn.example.com/a.mp4');
		expect(safeMediaSrc('data:video/mp4;base64,AAAA')).toBeNull();
		expect(safeMediaSrc('javascript:alert(1)')).toBeNull();
	});
});

describe('embed providers (the allowlist)', () => {
	const src = (url: string) => embedSourceOf(url)?.src ?? null;

	it('YouTube, Vimeo, Loom, Figma, CodePen and Spotify links map to their players', () => {
		const nocookie = `https://www.youtube-nocookie.com/embed/${YT}`;
		expect(src(`https://www.youtube.com/watch?v=${YT}`)).toBe(nocookie);
		expect(src(`https://youtu.be/${YT}`)).toBe(nocookie);
		expect(src(`https://m.youtube.com/watch?v=${YT}&t=42s`)).toBe(`${nocookie}?start=42`);
		expect(src(`https://www.youtube.com/shorts/${YT}`)).toBe(nocookie);
		expect(src(`https://www.youtube.com/embed/${YT}`)).toBe(nocookie);
		expect(src(nocookie)).toBe(nocookie);
		expect(src('https://vimeo.com/76979871')).toBe('https://player.vimeo.com/video/76979871');
		expect(src('https://player.vimeo.com/video/76979871')).toBe(
			'https://player.vimeo.com/video/76979871'
		);
		const loom = '0123456789abcdef0123456789abcdef';
		expect(src(`https://www.loom.com/share/${loom}`)).toBe(`https://www.loom.com/embed/${loom}`);
		const figma = 'https://www.figma.com/design/AbC123/My-file?node-id=0-1';
		expect(src(figma)).toBe(
			`https://www.figma.com/embed?embed_host=edytor&url=${encodeURIComponent(figma)}`
		);
		expect(src('https://codepen.io/someone/pen/abcDEF')).toBe(
			'https://codepen.io/someone/embed/abcDEF?default-tab=result'
		);
		expect(src('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')).toBe(
			'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC'
		);
	});

	it('anything else plays nothing: other hosts, look-alike hosts, bad ids, scripts', () => {
		for (const url of [
			'https://example.com/watch?v=dQw4w9WgXcQ',
			`https://youtube.com.evil.example/watch?v=${YT}`,
			`https://evil.example/?u=https://www.youtube.com/watch?v=${YT}`,
			'https://www.youtube.com/watch?v=abc"onload=alert(1)',
			'https://www.youtube.com/watch?v=',
			'https://vimeo.com/not-a-number',
			'javascript:alert(1)',
			`\u0001javascript://www.youtube.com/watch?v=${YT}`,
			'https://www.figma.com/',
			'mailto:a@b.c'
		])
			expect(src(url)).toBeNull();
	});

	it("a custom provider's player must be https: anything else is refused", () => {
		const evil: EmbedProvider = {
			name: 'Evil',
			embed: (url) => (url.host === 'evil.example' ? 'javascript:alert(1)' : null)
		};
		const plain: EmbedProvider = {
			name: 'Plain',
			embed: (url) => (url.host === 'plain.example' ? 'http://plain.example/player' : null)
		};
		const good: EmbedProvider = {
			name: 'Good',
			embed: (url) =>
				url.host === 'good.example' ? `https://good.example/embed${url.pathname}` : null
		};
		const providers = [...EMBED_PROVIDERS, evil, plain, good];
		expect(embedSourceOf('https://evil.example/x', providers)).toBeNull();
		expect(embedSourceOf('https://plain.example/x', providers)).toBeNull();
		expect(embedSourceOf('https://good.example/x', providers)?.src).toBe(
			'https://good.example/embed/x'
		);
	});

	it("a player on the page's own origin is refused (it could lift its own sandbox)", () => {
		vi.stubGlobal('location', { origin: 'https://app.example' });
		try {
			const self: EmbedProvider = {
				name: 'Self',
				embed: (url) =>
					url.host === 'app.example' ? `https://app.example/player${url.pathname}` : null
			};
			const other: EmbedProvider = {
				name: 'Other',
				embed: (url) =>
					url.host === 'other.example' ? `https://player.other.example${url.pathname}` : null
			};
			expect(embedSourceOf('https://app.example/x', [self])).toBeNull();
			expect(embedSourceOf('https://other.example/x', [other])?.src).toBe(
				'https://player.other.example/x'
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('the media kinds are void in defaultSemantics (the room and headless documents)', () => {
	it('embed, bookmark, file, video and audio are void', () => {
		for (const type of ['embed', 'bookmark', 'file', 'video', 'audio'])
			expect(defaultSemantics.roles[type]).toEqual({ void: true });
	});

	it('the slash menu lists each under Media', async () => {
		const { edytor } = await mount(
			[embedPlugin, bookmarkPlugin, createFilePlugin(), videoPlugin, audioPlugin],
			[{ type: 'paragraph' }]
		);
		const media = ['block.embed', 'block.bookmark', 'block.file', 'block.video', 'block.audio'];
		for (const id of media) expect(edytor.commands.get(id)?.group).toBe('Media');
		expect(media.map((id) => edytor.commands.get(id)?.label)).toEqual([
			'Embed',
			'Web bookmark',
			'File',
			'Video',
			'Audio'
		]);
	});
});

describe('embed', () => {
	it('an allowlisted URL renders a sandboxed iframe with the provider player, no srcdoc', async () => {
		await mount(
			[embedPlugin],
			[{ id: 'e', type: 'embed', data: { url: `https://youtu.be/${YT}` }, content: [] }]
		);
		const frame = document.querySelector<HTMLIFrameElement>('[data-edytor-embed] iframe')!;
		expect(frame.getAttribute('src')).toBe(`https://www.youtube-nocookie.com/embed/${YT}`);
		expect(frame.getAttribute('sandbox')).toBe(EMBED_SANDBOX);
		const tokens = EMBED_SANDBOX.split(' ');
		expect(tokens).toContain('allow-scripts');
		for (const unsafe of [
			'allow-top-navigation',
			'allow-top-navigation-by-user-activation',
			'allow-modals',
			'allow-downloads'
		])
			expect(tokens).not.toContain(unsafe);
		expect(frame.hasAttribute('srcdoc')).toBe(false);
		expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
		expect(frame.getAttribute('loading')).toBe('lazy');
		expect(frame.getAttribute('title')).toBe('YouTube');
	});

	it('a URL no provider plays (a peer may store anything) renders no iframe, only a safe link', async () => {
		await mount(
			[embedPlugin],
			[
				{ id: 'a', type: 'embed', data: { url: 'https://example.com/page' }, content: [] },
				{ id: 'b', type: 'embed', data: { url: 'javascript:alert(1)' }, content: [] },
				{ id: 'c', type: 'embed', data: { url: 'https://evil.example', srcdoc: '<b>x</b>' } }
			]
		);
		expect(document.querySelector('iframe')).toBeNull();
		const links = [...document.querySelectorAll('[data-edytor-embed-unsupported] a')];
		expect(links.map((a) => a.getAttribute('href'))).toEqual([
			'https://example.com/page',
			'https://evil.example'
		]);
		for (const a of links) expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
		expect(document.body.innerHTML).not.toContain('javascript:');
	});

	it('the empty panel embeds an allowlisted link, refuses another, in one data write', async () => {
		const { edytor } = await mount([embedPlugin], [{ id: 'e', type: 'embed', content: [] }]);
		await submitLink('https://example.com/not-a-player');
		expect(edytor.facade.blockDataOf('e')?.url).toBeUndefined();
		expect(document.querySelector('[data-edytor-media-error]')).not.toBeNull();
		const field = document.querySelector<HTMLInputElement>('[data-edytor-media-form] input')!;
		field.value = 'https://vimeo.com/76979871';
		field.dispatchEvent(new Event('input', { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await flushDomUpdates();
		expect(edytor.facade.blockDataOf('e')).toEqual({ url: 'https://vimeo.com/76979871' });
		expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
			'https://player.vimeo.com/video/76979871'
		);
	});

	it("an app's own provider list replaces the default one", async () => {
		const only: EmbedProvider = {
			name: 'Docs',
			embed: (url) =>
				url.host === 'docs.example' ? `https://docs.example/embed${url.pathname}` : null
		};
		await mount(
			[createEmbedPlugin({ providers: [only] })],
			[
				{ type: 'embed', data: { url: 'https://docs.example/a' }, content: [] },
				{ type: 'embed', data: { url: `https://youtu.be/${YT}` }, content: [] }
			]
		);
		const frames = [...document.querySelectorAll('iframe')];
		expect(frames.map((f) => f.getAttribute('src'))).toEqual(['https://docs.example/embed/a']);
	});

	it("a suggestion's preview mounts no frame: it cannot read the view's providers", async () => {
		const only: EmbedProvider = {
			name: 'Docs',
			embed: (url) =>
				url.host === 'docs.example' ? `https://docs.example/embed${url.pathname}` : null
		};
		const { edytor } = await mount(
			[createEmbedPlugin({ providers: [only] }), suggestionsPlugin],
			[{ id: 'p', type: 'paragraph', content: [] }]
		);
		edytor.suggestions.add({ after: 'p' }, [
			// YouTube is outside this view's list: never a frame.
			{ type: 'embed', data: { url: `https://youtu.be/${YT}` }, content: [] },
			{ type: 'embed', data: { url: 'https://docs.example/a' }, content: [] }
		]);
		await flushDomUpdates();
		const preview = document.querySelector('[data-edytor-suggestion]')!;
		expect(preview).not.toBeNull();
		expect(document.querySelector('iframe')).toBeNull();
		expect([...preview.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
			`https://youtu.be/${YT}`,
			'https://docs.example/a'
		]);
	});

	it('a readonly empty embed is a passive placeholder', async () => {
		await mount([embedPlugin], [{ type: 'embed', content: [] }], true);
		expect(document.querySelector('[data-edytor-media-placeholder]')).not.toBeNull();
		expect(document.querySelector('[data-edytor-media-add]')).toBeNull();
	});
});

describe('bookmark', () => {
	it('a link from the panel is stored, then unfurled into title, description and images', async () => {
		const unfurl = vi.fn(async () => ({
			title: 'Edytor',
			description: 'A block editor',
			image: 'https://edytor.dev/cover.png',
			icon: 'javascript:alert(1)'
		}));
		const { edytor } = await mount(
			[createBookmarkPlugin({ unfurl })],
			[{ id: 'b', type: 'bookmark', content: [] }]
		);
		await submitLink('https://edytor.dev/docs');
		expect(unfurl).toHaveBeenCalledWith('https://edytor.dev/docs');
		await vi.waitFor(() => expect(edytor.facade.blockDataOf('b')?.title).toBe('Edytor'));
		// An unsafe image URL from the unfurl is dropped.
		expect(edytor.facade.blockDataOf('b')).toEqual({
			url: 'https://edytor.dev/docs',
			title: 'Edytor',
			description: 'A block editor',
			image: 'https://edytor.dev/cover.png'
		});
		await flushDomUpdates();
		const card = document.querySelector<HTMLAnchorElement>('[data-edytor-bookmark] a')!;
		expect(card.getAttribute('href')).toBe('https://edytor.dev/docs');
		expect(card.getAttribute('target')).toBe('_blank');
		expect(card.getAttribute('rel')).toBe('noopener noreferrer nofollow');
		expect(card.textContent).toContain('Edytor');
		expect(card.textContent).toContain('A block editor');
	});

	it('without unfurl the card shows the URL; a hostile stored URL renders no link', async () => {
		await mount(
			[bookmarkPlugin],
			[
				{ type: 'bookmark', data: { url: 'https://example.com/x' }, content: [] },
				{ type: 'bookmark', data: { url: 'javascript:alert(1)', title: 'Click' }, content: [] }
			]
		);
		const links = [...document.querySelectorAll('[data-edytor-bookmark] a')];
		expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/x']);
		expect(links[0]!.textContent).toContain('https://example.com/x');
		expect(document.body.innerHTML).not.toContain('javascript:');
	});

	it('a readonly empty bookmark never unfurls', async () => {
		const unfurl = vi.fn(async () => ({}));
		await mount([createBookmarkPlugin({ unfurl })], [{ type: 'bookmark', content: [] }], true);
		expect(document.querySelector('[data-edytor-media-placeholder]')).not.toBeNull();
		expect(document.querySelector('[data-edytor-media-form]')).toBeNull();
		expect(unfurl).not.toHaveBeenCalled();
	});
});

describe('file', () => {
	it('an upload stores the URL, name and size; the block renders a download link', async () => {
		const upload = vi.fn(async () => 'https://files.example/report.pdf');
		const { edytor } = await mount([createFilePlugin({ upload })], [{ id: 'f', type: 'file' }]);
		document.querySelector<HTMLButtonElement>('[data-edytor-media-add]')!.click();
		await flushDomUpdates();
		const input = document.querySelector<HTMLInputElement>(
			'[data-edytor-media-upload] input[type=file]'
		)!;
		const file = new File(['%PDF-'], 'report.pdf', { type: 'application/pdf' });
		Object.defineProperty(input, 'files', { value: [file] });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await vi.waitFor(() =>
			expect(edytor.facade.blockDataOf('f')).toEqual({
				src: 'https://files.example/report.pdf',
				name: 'report.pdf',
				size: 5
			})
		);
		expect(upload).toHaveBeenCalledWith(
			file,
			expect.objectContaining({ progress: expect.any(Function) })
		);
		await flushDomUpdates();
		const link = document.querySelector<HTMLAnchorElement>('[data-edytor-file] a')!;
		expect(link.getAttribute('href')).toBe('https://files.example/report.pdf');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
		expect(link.textContent).toContain('report.pdf');
		expect(link.textContent).toContain('5 B');
	});

	it('an upload that lands after a peer filled the block, or after it died, writes nothing', async () => {
		let finish!: (src: string) => void;
		const upload = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
		const { edytor } = await mount(
			[createFilePlugin({ upload })],
			[
				{ id: 'f', type: 'file' },
				{ id: 'g', type: 'file' }
			]
		);
		const pick = async (index: number) => {
			document.querySelectorAll<HTMLButtonElement>('[data-edytor-media-add]')[index]!.click();
			await flushDomUpdates();
			const input = document.querySelectorAll<HTMLInputElement>('input[type=file]')[0]!;
			Object.defineProperty(input, 'files', { value: [new File(['x'], 'mine.pdf')] });
			input.dispatchEvent(new Event('change', { bubbles: true }));
			await vi.waitFor(() => expect(upload).toHaveBeenCalled());
		};
		// A peer sets the source while the upload runs: theirs stays.
		await pick(0);
		edytor.facade.apply(
			edytor.facade.prepare.setBlockData('f', { src: 'https://peer.example/theirs.pdf' })
		);
		finish('https://files.example/mine.pdf');
		await flushDomUpdates();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(edytor.facade.blockDataOf('f')).toEqual({ src: 'https://peer.example/theirs.pdf' });
		// The block is deleted while the upload runs: no command runs.
		upload.mockClear();
		await pick(0);
		edytor.facade.apply(edytor.facade.prepare.deleteBlock('g'));
		const last = edytor.dispatcher.last;
		finish('https://files.example/mine.pdf');
		await flushDomUpdates();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(edytor.dispatcher.last).toBe(last);
		expect(document.querySelector('[data-edytor-media-error]')).toBeNull();
	});

	it('without upload, no file picker; a link names the file from its path', async () => {
		const { edytor } = await mount([createFilePlugin()], [{ id: 'f', type: 'file' }]);
		await submitLink('https://files.example/docs/Q3%20plan.pdf');
		expect(document.querySelector('input[type=file]')).toBeNull();
		expect(edytor.facade.blockDataOf('f')).toEqual({
			src: 'https://files.example/docs/Q3%20plan.pdf',
			name: 'Q3 plan.pdf'
		});
	});
});

describe('video and audio', () => {
	it('render native players with a safe source only', async () => {
		await mount(
			[videoPlugin, audioPlugin],
			[
				{ type: 'video', data: { src: 'https://cdn.example/a.mp4' }, content: [] },
				{ type: 'audio', data: { src: 'https://cdn.example/a.mp3' }, content: [] },
				{ type: 'video', data: { src: 'javascript:alert(1)' }, content: [] }
			]
		);
		const video = document.querySelector('[data-edytor-video] video')!;
		expect(video.getAttribute('src')).toBe('https://cdn.example/a.mp4');
		expect(video.hasAttribute('controls')).toBe(true);
		const audio = document.querySelector('[data-edytor-audio] audio')!;
		expect(audio.getAttribute('src')).toBe('https://cdn.example/a.mp3');
		expect(document.querySelectorAll('video')).toHaveLength(1);
		expect(document.body.innerHTML).not.toContain('javascript:');
	});

	it('a video upload embeds the uploaded URL', async () => {
		const upload = vi.fn(async () => 'https://cdn.example/clip.webm');
		const { edytor } = await mount([createVideoPlugin({ upload })], [{ id: 'v', type: 'video' }]);
		document.querySelector<HTMLButtonElement>('[data-edytor-media-add]')!.click();
		await flushDomUpdates();
		const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
		expect(input.getAttribute('accept')).toBe('video/*');
		Object.defineProperty(input, 'files', { value: [new File(['x'], 'clip.webm')] });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await vi.waitFor(() =>
			expect(edytor.facade.blockDataOf('v')).toEqual({ src: 'https://cdn.example/clip.webm' })
		);
	});
});

describe('HTML import maps iframe, video and audio when a plugin claims them', () => {
	const paste = async (plugins: Plugin[], html: string) => {
		const view = await mount(plugins, [{ id: 'p', type: 'paragraph', content: [] }]);
		await setNativeSelection(view.edytor, view.edytor.idToBlock.get('p')!.firstText, 0);
		await dispatchClipboardPaste(view.editor, { 'text/html': html, 'text/plain': 'x' });
		return canonicalTree(view.edytor).filter((block) => block.type !== 'paragraph');
	};
	const all = [embedPlugin, videoPlugin, audioPlugin];

	it('an allowlisted iframe becomes an embed of its player URL; another iframe is dropped', async () => {
		expect(
			await paste(
				all,
				`<p>a</p><iframe src="https://www.youtube.com/embed/${YT}">fallback</iframe>` +
					'<iframe src="https://evil.example/x"></iframe>' +
					`<iframe srcdoc="<script>alert(1)</script>"></iframe>`
			)
		).toEqual([{ type: 'embed', data: { url: `https://www.youtube.com/embed/${YT}` } }]);
	});

	it('video and audio (a source child too) become their kinds; a figure keeps its caption', async () => {
		expect(
			await paste(
				all,
				'<video src="https://cdn.example/a.mp4" controls>no video</video>' +
					'<figure><audio controls><source src="https://cdn.example/a.mp3"></audio>' +
					'<figcaption>Theme</figcaption></figure>' +
					'<video src="javascript:alert(1)"></video>'
			)
		).toEqual([
			{ type: 'video', data: { src: 'https://cdn.example/a.mp4' } },
			{ type: 'audio', data: { src: 'https://cdn.example/a.mp3' }, content: [{ text: 'Theme' }] }
		]);
	});

	it('without the plugins nothing is imported from them', async () => {
		expect(
			await paste(
				[],
				`<iframe src="https://www.youtube.com/embed/${YT}"></iframe><video src="https://cdn.example/a.mp4"></video>`
			)
		).toEqual([]);
	});

	it('a copied embed, bookmark and file paste back as themselves', async () => {
		const bookmark = createBookmarkPlugin();
		const view = await mount(
			[embedPlugin, bookmark, createFilePlugin()],
			[{ id: 'p', type: 'paragraph', content: [] }]
		);
		const html = [
			`<figure><iframe src="https://www.youtube-nocookie.com/embed/${YT}"></iframe><figcaption>Talk</figcaption></figure>`,
			'<figure data-edytor-bookmark><a href="https://edytor.dev">Edytor</a><figcaption></figcaption></figure>',
			'<figure data-edytor-file><a href="https://files.example/a.pdf">a.pdf</a><figcaption></figcaption></figure>'
		].join('');
		await setNativeSelection(view.edytor, view.edytor.idToBlock.get('p')!.firstText, 0);
		await dispatchClipboardPaste(view.editor, { 'text/html': html, 'text/plain': 'x' });
		expect(canonicalTree(view.edytor).filter((b) => b.type !== 'paragraph')).toEqual([
			{
				type: 'embed',
				data: { url: `https://www.youtube-nocookie.com/embed/${YT}` },
				content: [{ text: 'Talk' }]
			},
			{ type: 'bookmark', data: { url: 'https://edytor.dev', title: 'Edytor' } },
			{ type: 'file', data: { src: 'https://files.example/a.pdf', name: 'a.pdf' } }
		]);
	});

	it('a plain figure is not claimed by a media kind (no tag-only void)', async () => {
		expect(
			await paste(
				[embedPlugin, bookmarkPlugin, createFilePlugin(), videoPlugin, audioPlugin],
				'<figure><figcaption>Just a caption</figcaption></figure>'
			)
		).toEqual([]);
	});
});
