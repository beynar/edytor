/**
 * The provider stack bound once to the vendored engine. The root's sync
 * factories (`collaboration/providers.ts`) and `edytor/protocol`'s raw
 * provider classes read this one stack, so each class exists once and
 * `instanceof` holds whichever entry point a consumer imported it from.
 */
import { Y } from '../engine.js';
import { bindProviders, type ProviderStack } from './index.js';

export const providers: ProviderStack = bindProviders(Y);
