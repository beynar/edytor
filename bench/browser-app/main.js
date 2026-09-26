import { mount, unmount } from 'svelte';
import BenchApp from './BenchApp.svelte';

// U0 mount milestones — stamped on the init-script-owned __BENCH_MOUNT__ so
// `mount()` decomposition is visible: module eval → mount() return (Edytor
// ctor + seed + sync render pass) → first editor DOM → all seeded blocks.
const M = window.__BENCH_MOUNT__;
if (M) M.mainStart = performance.now();

const app = mount(BenchApp, { target: document.getElementById('app') });

if (M) {
	M.mountReturn = performance.now();
	M.blocksAtMountReturn = document.querySelectorAll('[data-edytor-block="true"]').length;
	M.domAtMountReturn = document.querySelectorAll('[data-edytor]').length;
}

// Teardown hook for the bench driver.
window.__BENCH_UNMOUNT__ = () => unmount(app);
