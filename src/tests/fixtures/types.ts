import type { RenderResult } from '@testing-library/svelte';

import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';
import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
import type { Awareness, YDoc } from '$lib/crdt/index.js';
import type { EdytorSync } from '$lib/collaboration/index.js';
import type { NativeSelectionExpectation } from '../dom/test.utils.js';
import type { RenderedNode } from '../jsx/types.js';
import type { OperationResultExpectation, SelectionExpectation } from '../test.utils.js';
import type EdytorHarness from '../dom/EdytorHarness.svelte';

type FixtureBase = {
	description: string;
	plugins?: Plugin[];
	readonly?: boolean;
	value?: JSONDoc;
	only?: boolean;
	skip?: boolean;
};

export type ModelFixtureContext = {
	edytor: Edytor;
};

export type ModelFixtureBase = FixtureBase & {
	input: RenderedNode;
	output?: RenderedNode;
	result?: OperationResultExpectation;
	expectSelection?: SelectionExpectation;
};

export type ModelTransformFixture = ModelFixtureBase & {
	run: (context: ModelFixtureContext) => unknown | Promise<unknown>;
	assert?: (context: ModelFixtureContext & { result: unknown }) => void | Promise<void>;
};

export type ModelOperationFixture = ModelFixtureBase & {
	run: (context: ModelFixtureContext) => unknown | Promise<unknown>;
	assert?: (context: ModelFixtureContext & { result: unknown }) => void | Promise<void>;
};

export type JsxFixture = FixtureBase & {
	input: RenderedNode;
	output: unknown;
	run?: (context: { input: RenderedNode }) => unknown | Promise<unknown>;
	assert?: (context: { input: RenderedNode; result: unknown }) => void | Promise<void>;
};

export type CursorFixture = FixtureBase & {
	input: RenderedNode;
	output: unknown;
	run?: (context: { value: JSONDoc }) => unknown | Promise<unknown>;
	assert?: (context: { value: JSONDoc; result: unknown }) => void | Promise<void>;
};

export type ParserFixture<TInput = unknown, TResult = unknown> = FixtureBase & {
	input: TInput;
	output?: TResult;
	run?: (input: TInput) => TResult | Promise<TResult>;
	assert?: (context: { result: TResult; input: TInput }) => void | Promise<void>;
};

export type DomFixtureContext = RenderResult<typeof EdytorHarness> & {
	edytor: Edytor;
	editor: HTMLDivElement;
	expect: (jsx: RenderedNode) => void;
	value: JSONDoc;
};

export type DomFixture = FixtureBase & {
	input: RenderedNode;
	output?: RenderedNode;
	placeholder?: string;
	translate?: 'yes' | 'no';
	spellcheck?: boolean;
	autocorrect?: 'on' | 'off';
	autocomplete?: 'on' | 'off';
	autocapitalize?: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
	inputmode?: 'none' | 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url';
	enterkeyhint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
	doc?: YDoc;
	awareness?: Awareness;
	sync?: EdytorSync;
	autoSelectFixture?: boolean;
	onChange?: (value: JSONBlock) => void;
	onSelectionChange?: (selection: EdytorSelection) => void;
	run: (context: DomFixtureContext) => unknown | Promise<unknown>;
	expectSelection?: SelectionExpectation;
	expectNativeSelection?: NativeSelectionExpectation;
	assert?: (context: DomFixtureContext & { result: unknown }) => void | Promise<void>;
};

export type FixtureModule<TFixture> = {
	default?: TFixture;
	fixture?: TFixture;
	fixtures?: TFixture[];
};

export const defineModelTransformFixture = (fixture: ModelTransformFixture) => fixture;

export const defineModelOperationFixture = (fixture: ModelOperationFixture) => fixture;

export const defineJsxFixture = <TOutput>(fixture: JsxFixture & { output: TOutput }) => fixture;

export const defineCursorFixture = <TOutput>(fixture: CursorFixture & { output: TOutput }) =>
	fixture;

export const defineParserFixture = <TInput, TResult>(fixture: ParserFixture<TInput, TResult>) =>
	fixture;

export const defineDomFixture = (fixture: DomFixture) => fixture;

export const defineFixtures = <const TFixture>(fixtures: TFixture[]) => fixtures;
