import { render } from 'svelte/server';
import ReadonlyApp from './ReadonlyApp.svelte';

/**
 * SSR entry for `vite build --ssr`: renders the readonly editor through the
 * supported Svelte build path (vite-plugin-svelte SSR compilation). The
 * smoke script imports the built bundle and asserts on the emitted markup —
 * this is the meaningful SSR check, NOT plain node importing .svelte.
 */
const result = render(ReadonlyApp);

export const html = result.body ?? result.html ?? '';

/** One more server render, read to completion (`render()` is lazy): the leak check repeats it. */
export const renderOnce = () => render(ReadonlyApp).body;
