# Performance Analysis Report - Edytor

## Executive Summary

This report documents performance bottlenecks identified in the edytor rich text editor codebase. The analysis focuses on DOM operations, selection handling, and component rendering inefficiencies that impact user experience during text editing operations.

## Critical Performance Issues

### 1. TreeWalker Recreation in Selection Handling (HIGH IMPACT)

**Location:** `src/lib/selection/selection.svelte.ts`
**Methods:** `findTextNode()` (lines 391-415), `setAtTextRange()` (lines 494-526)

**Issue:** New TreeWalker instances are created on every selection change operation, which is one of the most frequent operations in a text editor.

**Current Code:**

```typescript
private findTextNode = (node: HTMLElement, offset: number = 0) => {
    const treeWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
    });
    // ... rest of method
}
```

**Impact:** High - Affects every cursor movement, text selection, and click operation
**Frequency:** Very High - Triggered on every selection change event
**Performance Cost:** DOM API overhead + function allocation on each call

### 2. Inefficient Whitespace Removal with MutationObserver (MEDIUM-HIGH IMPACT)

**Location:** `src/lib/components/Edytor.svelte`
**Method:** `noWhiteSpace` action (lines 169-202)

**Issue:** Creates TreeWalker instances on every DOM mutation to remove whitespace nodes.

**Current Code:**

```typescript
const observe = (mutation?: MutationRecord[]) => {
	const treeWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			if (!node.textContent || node.textContent.match(/^[\s\u200B-\u200D\uFEFF]*$/)) {
				return NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_REJECT;
		}
	});
	// ... DOM manipulation
};
```

**Impact:** Medium-High - Runs on every DOM change
**Frequency:** High - Triggered by all content modifications
**Performance Cost:** Unnecessary DOM traversals and node removals

### 3. Block Traversal Operations (MEDIUM IMPACT)

**Location:** `src/lib/block/block.svelte.ts`
**Methods:** `closestPreviousBlock`, `closestNextBlock`, `path` getter

**Issue:** Complex traversal algorithms that recalculate on every access without memoization.

**Current Code:**

```typescript
get closestPreviousBlock(): Block | null {
    const previousBlock = this.previousBlock;
    if (this.index === 0) {
        return this.parent instanceof Block ? this.parent : null;
    } else if (previousBlock) {
        if (previousBlock?.children.length > 0) {
            let closestPreviousBlock = previousBlock.children.at(-1) || null;
            while (closestPreviousBlock && closestPreviousBlock?.children.length > 0) {
                closestPreviousBlock = closestPreviousBlock.children.at(-1) || null;
            }
            return closestPreviousBlock || null;
        } else {
            return this.previousBlock;
        }
    }
    return null;
}
```

**Impact:** Medium - Affects navigation and block operations
**Frequency:** Medium - Called during block operations and navigation
**Performance Cost:** Recursive traversals without caching

### 4. Plugin Operation Loops (MEDIUM IMPACT)

**Location:** `src/lib/text/text.utils.ts`, `src/lib/edytor.svelte.ts`
**Methods:** `batch()` function, plugin initialization

**Issue:** Multiple iterations through plugin arrays for each operation.

**Current Code:**

```typescript
for (const plugin of this.edytor.plugins) {
	const normalizedPayload = plugin.onBeforeOperation?.({
		operation,
		payload,
		text: this,
		block: this.parent,
		prevent
	}) as TextOperations[O] | undefined;
	if (normalizedPayload) {
		finalPayload = normalizedPayload;
		break;
	}
}
```

**Impact:** Medium - Affects all text operations
**Frequency:** High - Called for every text modification
**Performance Cost:** Array iteration overhead on each operation

### 5. DOM Query Operations (LOW-MEDIUM IMPACT)

**Location:** `src/lib/dnd.svelte.ts`
**Methods:** `updateDropIndicator()`

**Issue:** Uses `document.querySelectorAll()` to find and remove elements.

**Current Code:**

```typescript
document.querySelectorAll('.drop-indicator').forEach((el) => {
	if (el instanceof HTMLElement) {
		el.remove();
	}
});
```

**Impact:** Low-Medium - Affects drag and drop operations
**Frequency:** Low - Only during drag operations
**Performance Cost:** Global DOM queries

## Performance Optimization Recommendations

### Priority 1: TreeWalker Caching

- Implement WeakMap-based caching for TreeWalker instances
- Reuse TreeWalkers for the same DOM nodes
- Estimated improvement: 30-50% reduction in selection operation time

### Priority 2: Whitespace Removal Optimization

- Debounce whitespace removal operations
- Use more targeted DOM queries instead of full tree traversal
- Estimated improvement: 20-30% reduction in DOM mutation overhead

### Priority 3: Block Traversal Memoization

- Cache computed block relationships
- Invalidate cache only when block structure changes
- Estimated improvement: 15-25% reduction in navigation time

### Priority 4: Plugin Operation Optimization

- Pre-filter plugins by operation type
- Use Map-based lookup instead of array iteration
- Estimated improvement: 10-20% reduction in operation overhead

## Testing Strategy

1. **Functional Testing:** Ensure all selection operations work correctly
2. **Performance Testing:** Measure selection change latency before/after
3. **Regression Testing:** Run existing test suite to verify no breakage
4. **Manual Testing:** Test cursor movement, text selection, and editing flows

## Implementation Plan

The first optimization to implement is TreeWalker caching in selection handling, as it has the highest impact and frequency of execution. This change will be backward-compatible and doesn't affect the public API.
