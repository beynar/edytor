import { mount, unmount } from 'svelte';
import App from './App.svelte';

const app = mount(App, { target: document.getElementById('app') });

// Teardown hook for the packed-consumer driver: supported svelte 5
// `unmount()` — the Edytor component's own destroy path runs inside it.
window.__EDYTOR_PACKED_UNMOUNT__ = () => unmount(app);
