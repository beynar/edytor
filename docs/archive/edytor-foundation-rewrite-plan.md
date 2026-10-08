# Edytor foundation: requirements, design experiments, implementation, and replacement

Status: proposed execution plan, 2026-09-26. This document does not claim that a replacement architecture has been implemented or qualified. It does not supersede active bug fixes. It defines a complete route from behavioral requirements to a measured replacement of the editor and, where justified, its vendored engine.

Independent-review refinements incorporated: race programs may interleave work before settlement; storage selection includes early migration/pending-update feasibility; final qualification has an aggregate repair checkpoint. The reviews assessed the plan, not runtime correctness.

The plan is definitive about scope, work units, decision gates, and evidence. The storage representation is an experiment to resolve, not an answer disguised as a requirement.

## 1. Correction to the previous proposal

The previous answer identified useful responsibilities but gave some existing mechanisms too much authority. Stable character IDs, immutable backing texts, slice claims, a projected document, anchors, and a particular transaction API are possible answers. They are not all requirements. Logical continuity does not require bytes to remain in one physical buffer.

Starting with four layers or a smaller selection type also does not establish compression. A smaller selection still needs explicitly chosen typing marks, composition ownership, and focus intent. A browser is not only a derived display while it holds provisional native input. A shared position resolver must not impose the same deletion recovery on a caret, a remote presence location, and a historical reference.

The revised starting question is:

> What must an edit preserve or change in content, structure, references, and interaction—and which representation makes those answers follow from the same facts?

The working implementation is evidence of requirements, supported integrations, difficult cases, and actual costs. It is neither the specification nor an architecture that must survive. A rewrite is equally not entitled to discard a requirement merely because its first representation cannot express it.

## 2. Goal, scope, and completion

**Goal:** replace accumulated interpretations and repairs with a smaller set of authoritative semantic relationships, while preserving the agreed editing behavior, collaboration, recoverability, extensibility, and supported integrations. Measure maintained code and runtime work separately.

**Included:** document creation/loading; rich text and valued marks; inline atoms; block structure; split/join/delete/move/nest/unnest; ranges; native input and composition; local and remote selections; undo/redo; default awareness; paragraph attribution; the existing bounded lineage capability; persistence and sync; Svelte rendering; plugins and consumer API; vendored storage and encoding; packaging and migration.

**Not added:** a general-purpose CRDT framework, a new UI framework, a comments product, arbitrary workflow orchestration, new block families, hosted authentication, or a new network service. Comment-like references may be a tiny semantic probe to expose inappropriate shared recovery, not a shipped feature.

**Preserve the product choices already made:** paragraph attribution remains the editing default. Existing native engine attribution and legacy stored attribution are inventoried for compatibility; this plan does not reintroduce per-character authorship capture. Awareness and history are available by default. Lineage remains its own capability and retention policy, not another name for undo or a complete audit trail.

**Done when:** the candidate meets the agreed contracts and finite qualification gate; two bounded extensions demonstrate reuse of the same rules; the deletion ledger identifies real removed machinery; runtime and packaging comparisons identify the exact source measured; compatibility or an explicitly accepted replacement path is proven; and the old runtime can be retired without losing supported data or behavior. A decision not to replace the engine is a valid design-experiment outcome, but is not completion of the entire rewrite.

This is a planning artifact. Do not start implementation merely because this file exists. When asked to execute it, proceed through routine reversible work without repeated confirmation. Ask only for an unresolved product policy or a concrete incompatible public, storage, or wire decision. Do all independent work before presenting that decision.

## 3. The necessary facts

These are semantic facts, not proposed classes or storage fields.

1. **A document has meaningful occurrences and relationships.** It contains ordered content, block relationships, inline objects, presentation properties, and semantic constraints. Two identical-looking occurrences are not necessarily interchangeable to a reference or an edit.
2. **An action has an intended target and effect.** It changes selected content or relationships while preserving everything outside its scope, except for explicitly defined consequences and conflict rules. Local command success, network receipt, and durable persistence are different outcomes.
3. **Continuity matters across change.** Moving, formatting, splitting, and joining must preserve the relationships needed for ongoing editing and supported references. Deleting a target is different from temporarily lacking the information to locate it.
4. **Collaborators can act with partial knowledge.** They may edit offline. Accepted changes can arrive late, repeatedly, or in different permitted orders. Equivalent accepted change sets must eventually produce the same valid document under the same semantics. Causality does not itself choose the product's conflict policy.
5. **An interaction has an owner and a lifetime.** Current user intent, a resolved offset, a DOM binding, and provisional composition have different authority and expiration conditions. A newer intent cannot be overwritten by older deferred work.
6. **Some past facts must remain available for specific purposes.** Undo, paragraph attribution, displaced-state lineage, saved documents, and pending remote changes retain different information for different durations. One retained history is not automatically a substitute for the others.

The environment adds constraints: browser input and layout are asynchronous; native editing varies by platform; processes and transports fail; data outlives a view; and documents must remain responsive at the agreed scale. No claim of arbitrary-size performance or permanent reference resolution is implied.

## 4. The rules that must have one semantic owner

### R1 — Scope and continuity

For each edit, define its target, preserved content, changed relationships, surviving identities where observable, and resulting interaction. Text deletion, block deletion, replacement, and duplication are different operations. Different commands may compose the same editing rule without becoming identical commands.

### R2 — Valid meaning under concurrency

Define the allowed document and the outcome of relevant conflicting actions. Local validity does not imply validity of concurrent combinations. Different replicas must not independently repair the same logical conflict using unrelated local observations.

Do not assume that every intent can survive a conflict. State which outcome wins, what is retained for recovery, and which intermediate observations are allowed before all dependencies arrive.

### R3 — Reference facts before recovery policy

Reference evaluation establishes a current location, a known deletion, unavailable causal information, an incompatible reference, or another explicitly specified condition. These are meanings to preserve; the final return type is a later design decision.

The reference consumer owns the response. A local caret may recover to an editable neighbor. Remote presence must not invent a new user intention. A historical bookmark may retain a deleted target. A comment-like probe may remain attached to deleted content rather than jump to an unrelated paragraph.

All consumers share the facts about the target. They do not have to share a recovery algorithm.

### R4 — Authority expires with its observation

A resolved offset is true for the document state used to resolve it. A DOM node represents content for its mounted lifetime. An asynchronous attempt does not acquire authority to restore either observation after its premises change.

One admission rule owns whether a selection write is still authorized. Composition, history requests, user gestures, and mount attempts retain their necessary distinctions; a universal counter or mutable context must not erase them.

### R5 — Declared effects have a coherent boundary

Define what is visible after an accepted semantic action, including content, structural consequences, history capture, attribution, and applicable displaced-state capture. Define no-op and refusal behavior. A refused operation must not silently leave partial accepted effects.

One logical edit need not mean one packet, engine transaction, or persistence row. If it requires multiple physical records, specify partial-delivery and crash behavior. A repair arriving later cannot be advertised as an already complete atomic semantic result.

### R6 — Shared meaning, appropriate execution

Keyboard input, native target ranges, paste, DND, and programmatic commands may obtain their intent differently. Once an operation and its validated target are established, they must not independently redefine the same structural or text rule.

Headless word deletion and a browser-provided visual-line deletion need not execute identical algorithms. Their platform evidence and contract must be explicit. Composition is provisional input with a lifecycle, not a list of ordinary insert commands by assumption.

## 5. Fact → authority → lifetime → consumers

Use this inventory before drawing a module diagram. The authority column names a responsibility, not a required object.

| Fact                                                            | Authoritative responsibility          | Validity / retention                              | Consumers                                       |
| --------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| Accepted document meaning and semantic configuration            | Document admission and interpretation | For that admitted configuration/version           | Commands, sync, persistence, views              |
| Current ordering, containment, and content ownership            | Structural/content semantics          | Until relevant changes are integrated             | Commands, references, rendering, navigation     |
| Meaning of a content or boundary reference                      | Reference semantics                   | Within its declared causal and retention envelope | Selection, presence, history, annotation probes |
| Resolved coordinates and selection-derived flags                | A single snapshot-bound observation   | That document snapshot                            | Commands, toolbar, rendering                    |
| Current editing intent, explicit typing marks, atomic selection | Interaction owner                     | Until superseded or ended                         | Input, commands, DOM binding                    |
| Provisional native input                                        | Composition/input attempt owner       | Commit, cancellation, or specified interruption   | Input bridge, history grouping, view            |
| Content-to-node mapping and geometry                            | Browser binding                       | Current mount/layout                              | Native selection, handles, hit testing          |
| Which local effects belong to an undo group                     | History capture policy                | Group/history lifetime                            | Undo and redo                                   |
| Who contributed and which displaced state was retained          | Attribution and lineage policies      | Their separate durable retention contracts        | Author UI, recovery/history UI, encoding        |
| Which accepted changes have reached storage or a peer           | Persistence or transport boundary     | Its documented acknowledgement scope              | Readiness, reconnect, recovery                  |
| Ownership of subscriptions, providers, and views                | Creator/borrower lifecycle            | Acquisition to release                            | Mount/unmount, attach/detach, destroy           |

Derived views may be cached. Each cache must identify its source and invalidation rule; a cache is not a second authority. Necessary pre-change capture is not redundant recomputation: after a destructive edit, its displaced state may no longer be derivable.

## 6. Policy register: settle behavior before encoding

U1 turns these rows into normative scenarios. Mark each as user requirement, verified supported contract, proposed default, or unresolved. Existing source observations alone do not establish correctness.

| Family                     | Decisions to make explicit                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deletion and join          | Endpoint inclusion; surviving block/type; children preservation/promotion; empty document destination; atomic/island boundaries; forward/reversed equivalence                                                 |
| Concurrent structure       | Delete versus insert/move/format; moving a descendant out of a deleted ancestor; concurrent split/join; move cycles; multi-block move membership/order and conflict granularity                               |
| References                 | Content attachment versus structural-boundary attachment; insertion affinity; empty-space positions; same-block mark boundaries versus opposite sides of an inline atom; deletion versus missing dependencies |
| History                    | Locality by session/origin rather than actor label; grouping; undo after remote insert/format/move/split/join; redo; two views sharing history; same actor in separate sessions; reload behavior              |
| Formatting and annotations | Valued marks, overlap and removal; insertion inheritance; collapsed typing marks; formatting across atoms and blocks; mark boundary affinity; supported annotation retention                                  |
| Native input               | Native target-range interpretation; grapheme/word/visual-line unit ownership; IME provisional visibility, commit/cancel, remote interference; paste/drop duplication handling                                 |
| Attribution and lineage    | Paragraph defaults; creator/contributors/last change; which edits count; no-op behavior; split/join propagation; undo effects; pre-displacement snapshots; retention and reincarnation                        |
| Admission and lifecycle    | Fresh versus awaiting hydration; unknown types and semantic versions; invalid partial input; borrowed resources; readonly; attaching multiple views; pending reference behavior                               |
| Compatibility              | JSON/API preservation; raw engine access; persisted encodings; native attribution support; existing reference serialization; mixed-version sync; migration and downgrade boundaries                           |

Preserve established product choices where coherent. For example, documented delete-wins behavior is the compatibility starting point, not proof that it is the only valid policy. Resolve contradictions with a small exact scenario rather than silently selecting whichever result the candidate produces.

Historical authorship, actor identity, storage client identity, and undo-group identity are not interchangeable. Likewise, lineage is currently a bounded collection of displaced subtree snapshots; it is not automatically a structural ancestry graph or an undo stack.

## 7. Representation experiment and deletion ledger

Begin with one candidate and at most one serious alternative. Do not build several complete editors or a generic abstraction to support them all.

**Leading hypothesis:** represent ordered content and meaningful structural boundaries directly, so editing and references can describe the same relationships without depending on rendered text runs. This does not preselect a global token stream, per-block sequences, immutable buffers, a graph of claims, or a particular anchor encoding.

The candidate must explain, on paper and in a small implementation:

- How two textually identical occurrences remain distinguishable where behavior requires it.
- How the end of one block differs from the start of the next, including empty blocks.
- How adjacent inline atoms have valid editing boundaries without requiring artificial semantic text.
- What splitting/joining changes, what it preserves, and how references learn that fact.
- How containment, order, and content transfers compose under concurrency.
- How undo restores the specified relationship without relying on information unavailable to other replicas.
- What survives compaction, reload, or delayed delivery, and what is deliberately no longer resolvable.

Do not settle the representation by saying it is elegant. Complete this ledger for each proposed simplification:

| Machinery that may disappear                                            | Replacement relationship/rule                              | Condition for deletion                                               | Falsifying witness                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Empty semantic Text separators and their repair                         | Editable boundaries exist directly                         | Every empty/atom boundary is addressable without a fake text entity  | Adjacent atoms; deleting the last text; typing between atoms      |
| Independently maintained offsets, wrapper ownership, and boundary flags | One resolved observation of the current selection          | Consumers use facts from the same snapshot                           | Remote edit between observation and deferred write                |
| Semantic recovery based on mounted nodes                                | Semantic destination independent of binding                | Core can distinguish absent editing space from unmounted valid space | Delete everything, then type before replacement mount             |
| Several structural-delete interpretations                               | Shared operation semantics after intent resolution         | Every relevant entry path uses that semantic owner                   | Same range via key, cut, native input, and programmatic command   |
| Formatting-run changes relocating references                            | Presentation segmentation separate from reference meaning  | Mark-only segmentation preserves logical gaps                        | Add/remove a valued mark around a passive caret                   |
| Reconstructed displaced ownership during undo                           | Sufficient causal relationship retained at the owning edit | Remote receivers and reload derive the same restored relationship    | Delete tail; remote restructure; undo on one peer; reload another |
| Repeated ownership/placement scans                                      | One maintained semantic relation and scoped indexes        | Updates invalidate the complete affected dependency set              | Split/join/move combinations and fragmented long text             |
| Per-caller stale selection guards                                       | One admission responsibility for actual writes             | All success, retry, rejection, focus, and teardown exits pass it     | String-ID failure and newer same-position gesture                 |

Some rows may prove nonremovable. Record why, and count the retained cost. A helper wrapping the old mechanism earns no deletion credit. A new owner must identify the invariant it establishes, not merely the parameters it carries.

## 8. Work units and dependencies

Each unit has one accountable owner, a bounded outcome, evidence, and a gate. These are work packages, not a requirement to create eleven runtime modules. Keep one shared decision/evidence ledger and create additional architecture documents only for actual durable decisions.

Sequence: **U0 → U1 → U2 → U3 → U4 → U5 → U6 → U7 → U8 → U9 → U10**. Early probes deliberately exercise history and composition before their full integration units. Independent test/spec review and measurement preparation can run in parallel. Never give two writers overlapping files.

### U0 — Preserve the reference and freeze the comparison

**Outcome:** the replacement can be evaluated without overwriting active work or comparing moving targets.

- Inventory the current dirty tree, including relevant untracked source. Preserve an immutable source-identified snapshot outside runner-owned output directories. A worktree at HEAD alone does not contain current uncommitted work.
- Coordinate with the agent finishing selection fixes. Include the agreed fixes in the baseline; do not restart that remediation program or build a candidate against an undocumented mixed snapshot.
- Inventory supported commands, plugin interception/normalization, entry points, raw-engine reachability, document services, provider contracts, data versions, and known unresolved behaviors.
- Record toolchain/lockfile/source hashes and a small initial measurement set. Do not inherit previous green counts or benchmark claims as current results.
- Freeze the intended release's supported-input matrix: browser engines, actual OS/browser/IME combinations, and any required touch/mobile paths. Resolve existing support claims rather than adding new platforms. Mark each combination mandatory or explicitly outside the release claim. Missing mandatory equipment/evidence blocks that support claim and its cutover gate; it is not a pass with a footnote.
- Declare the maintenance-cost acceptance rule before candidate implementation: name the redundant mechanisms to retire, count all replacement/shared/compatibility code, and require a net reduction in maintained production footprint at equivalent supported scope. If the candidate grows, the default compression gate fails and replacement requires an explicit acceptance of that tradeoff, even if runtime improves. No arbitrary percentage reduction is required.
- Keep an explicit exception register for acknowledged baseline defects. They are not parity requirements; they require independent intended outcomes.

**Artifacts:** source manifest, surface/behavior inventory, baseline evidence, initial decision/deletion ledger. These can share one report.

**Gate:** no work is lost; the exact reference is runnable; each in-scope capability has an owner in the later units. No product edits yet.

### U1 — Write the independent behavior contract

**Outcome:** the system's required meaning is explicit without naming its current mechanisms.

- Fill the policy register and fact inventory. Use a compact vocabulary for occurrence, boundary, action, reference, observation, interaction, and retained history. Do not turn the vocabulary into a runtime class list.
- Write exact before/action/after examples for the boundary matrix below. Specify tree, text, valued marks, relevant identities, references, selection shape, and continuation. Separate sequential and concurrent scenarios.
- State local publication, partial-delivery, refusal, persistence, and retention guarantees separately.
- Reconcile current deletion contracts with the intended outcomes. Imported implementation details and contradictory historical notes are not normative.
- For each real ambiguity, present the smallest example plus the alternatives and their user-visible consequence. Routine representation decisions need no user approval; incompatible behavior does.
- Freeze two exact consumer-extension probes and their combinations, but leave their candidate implementations absent until the U8 source checkpoint. Use test-only consumers of existing product capabilities: (E1) a plugin combining a valued mark with an inline object and explicit typing marks around it; (E2) an alternate command/input adapter for nested relocation while another session holds a selection. Qualify E1, E2, and their combination against the same reference/recovery rules. No new shipping feature is required.

**Artifacts:** one normative contract with stable scenario IDs and hand-authored fixtures. Expected values must not be generated from either implementation.

**Gate:** every critical policy row has an executable expectation or an explicitly bounded decision that blocks only dependent work. No unresolved critical rule may be hidden in a resolver fallback.

### U2 — Falsify the leading representation cheaply

**Outcome:** a candidate earns its foundational relationships before production-scale implementation.

- Implement a deliberately small, slow semantic model for the mandatory example family. No DOM, vendor internals, generic provider abstraction, or complete editor API.
- Implement sequential split/edit/join/delete, marked inline content, references, and the required recovery distinctions. Include empty spaces and an inline-atom boundary immediately.
- Define how the candidate represents concurrent actions and their causal context. Enumerate the small concurrent cases before choosing storage. A sequential reference model alone is not a concurrency oracle.
- Test the same rule at root and nested positions. Add the first history and provisional-composition scenarios at the semantic level.
- Complete the deletion ledger for the mechanisms the candidate claims to remove.
- If the first representation fails because it lacks a fact, identify that fact. Try at most one alternative representation; do not accumulate compensating exceptions indefinitely.

**Artifacts:** bounded executable model, exact scenario results, candidate comparison, decision explaining retained distinctions and expected deletions.

**Gate:** one candidate handles the mandatory slice and its second placement without a second interpretation of ownership/reference meaning. The chosen representation and operation semantics are explicit enough to implement. If neither candidate passes, report the unresolved representation question; do not call the design complete.

### U3 — Prove the causal/storage boundary

**Outcome:** the chosen semantics survive real collaboration, encoding, and undo mechanics.

- Implement the same bounded slice against the actual retained or modified causal substrate in an isolated candidate path. Production exports and the working demo remain on the reference.
- First test whether the retained engine can express the semantics without rebuilding the old repair network. If not, identify the exact missing primitive and implement a bounded specialization. Replacing unrelated decoding or synchronization is not a prerequisite.
- Exercise two and three replicas, delayed/missing dependencies, duplicates, reordered delivery, batching, late join, reload, and offline edits. Distinguish deterministic integration from deterministic user-intent outcomes.
- Prove reference behavior through split/join/move/deletion and same-gap insertions. Test serialization before choosing a compact encoding. Do not overload an association number merely because the engine accepts it.
- Include selective undo probes now: remote insertion between delete and undo; split then remote edits to both sides then undo; undo after relocation. All replicas and a fresh reload must agree on the intended ownership, not merely conserved characters.
- Build one minimal real-browser composition probe on the candidate: split, compose at the new start, and receive a neighboring/same-gap remote edit. This exposes representation problems before the full adapter port.
- State retention/compaction requirements. Old references, undo, and offline clients constrain garbage collection; hidden data is not necessarily disposable data.
- Before selecting storage, run one representative saved-document admission/conversion probe containing structure, marks, attribution/lineage, and relevant reference information. Work on preserved copies. Also test an old-format offline update created before conversion and delivered afterward. For compatible storage, prove integration; for an incompatible generation, demonstrate the proposed bridge/conversion or explicit refusal with preserved bytes and a defined recovery route. A fresh-document round trip alone does not satisfy this probe. Resolve an exposed incompatible contract before expanding the candidate; full migration qualification remains in U10.
- Record how much legacy machinery the feasibility probes require retaining, so the storage choice includes its compatibility cost rather than discovering it only during final compression.
- Freeze the aggregate qualification-repair checkpoint before U4 begins. The default is three U9 repair rounds for the integrated candidate, across all failure categories; a different limit requires an explicit recorded decision before qualification. This is separate from the per-distinction representation limit below.

**Artifacts:** one causal candidate, source-identified traces, storage decision, compatibility implications, focused engine/vendor patches with provenance when needed.

**Gate:** the vertical slice passes the causal and browser probes, and the saved-document/pending-update probes establish a viable accepted compatibility or generation-transition route. Choose explicitly: retained substrate, specialized vendor, or replacement engine. A full replacement must show the same integration/retention evidence; it is not approved merely because this is called a rewrite. Compatibility feasibility cannot remain an untested assumption behind the storage decision.

### U4 — Complete the headless semantic editor

**Outcome:** all agreed editing operations have one meaning independent of rendering.

- Implement the operation contract: insert/replace/delete, marks and valued marks, inline atoms, block create/delete/replace/duplicate, split/join, move/grouped move/nest/unnest, data/type updates, and ranges across nested structures.
- Establish semantic block capabilities before use: own editing space, children, isolated boundaries, and actual special-type rules. Container absence and temporary DOM absence must be distinguishable without a browser.
- Provide one mutation/admission boundary with transaction-aware reads and coherent publication. Preserve no-op/refusal behavior without per-facade duplicated preflight decisions.
- Capture required pre-displacement evidence at the operation that owns it. Derive changed projections once; do not recover destroyed information from the final document.
- Make direct commands and nested batches obey the same validation, ownership, and failure rules. Define plugin interception authority, normalization determinism, and reentrancy explicitly.
- Make headless format/run queries available without Svelte wrappers. Allow incremental views without introducing a second authored model.

**Gate:** each command has exact result and no-op/refusal witnesses, including root/nested and composed cases. Full canonical tree comparisons retain relevant IDs, data, marks, and children. Normalization does not depend on independent view-specific repair writes.

### U5 — Integrate interaction, history, attribution, and awareness

**Outcome:** default services use the same semantic facts while retaining their distinct authority and lifetimes.

- Selection stores the necessary intent: text or atomic-block selection, direction, explicit typing marks, and the context needed for ongoing interaction. Snapshot-derived fields are observed together instead of independently authored.
- Reference evaluation reports facts. Local recovery, historical lookup, and remote-presence rendering apply their own specified policy. Missing dependencies must not masquerade as proven deletion.
- History follows its local capture/grouping contract; a user ID is not a capture scope. Two views sharing a document and two replicas using one actor are separate test cases. Undo is a causal operation with defined conflicts, not blindly applying an old absolute inverse.
- Paragraph attribution and existing lineage use owned semantic outcomes and pre-change capture. Test actor switch, delete/replace/children replacement, split/join, no-op, undo/redo, concurrent checkpoints, retention, and identity reincarnation. Do not claim a bounded visible ring guarantees bounded encoded history.
- Awareness is default ephemeral collaboration state. Specify staleness, disconnect/reconnect, sequence ordering, session identity, and references arriving before content. Do not persist live presence as ordinary document content merely to make it built in.
- Centralize actual selection-write admission, including newer identical-position gestures. Preserve separate composition, user-intent, history, and mount lifetimes.
- Resource acquisition establishes destruction authority. Multiple views do not duplicate services; releasing a borrowed view/document does not destroy a caller-owned resource.

**Gate:** exact continuation after every recovery scenario; local undo preserves unrelated remote work; attribution and lineage match the contract; presence never fabricates a user action; teardown leaves no authorized late writes or duplicate captures.

### U6 — Build the browser and Svelte adapters

**Outcome:** browser-specific evidence reaches the headless semantics without creating a second editor model.

- Translate DOM selections and input events into admitted intent/evidence. Keep native word/line/grapheme boundaries distinct from headless fallback units; specify how phantom placeholder ranges are bounded and mapped.
- Render semantic content into spans/atoms and establish a mount-scoped mapping. Placeholder nodes and mark segmentation must not acquire semantic identities that commands depend on.
- Treat composition as provisional input: explicit commit/cancel/interruption, grouping, and policy for remote edits or deletion of its destination. Choose buffering, rebasing, or interruption only from the contract; no silent loss or duplication.
- Project the current authorized selection when its target is mounted. Late mount, focus changes, rejected lookups, DOM repair, and disconnected views use the same admission rule. Do not solve this with independent timers restoring captured offsets.
- Route keyboard, beforeinput/input fallback, clipboard, paste/drop, and programmatic entry points through their appropriate shared semantics. Preserve browser-specific execution where evidence requires it.
- Port Svelte plugins, readonly behavior, syntax/mark rendering, menus, and DND. DND preview and commit use the same planned destination validity; root/nested movement does not get separate structural semantics.
- Keep rendering incremental. Typing in one block must not require reconstructing all wrappers or scanning the full editor for placeholders.
- Include one pinned heterogeneous collaboration program with Chromium, Firefox, and WebKit peers in the same room, in addition to per-engine runs. The current collaboration runner selects one engine for the whole run; supporting this probe is a bounded test-driver adaptation, not an existing capability to claim. Reuse the named high-risk scenario budget rather than multiplying every seed across all engine combinations.

**Gate:** real-browser programs pass in Chromium, Firefox, and WebKit with recorded versions. Every mandatory native-input combination from U0 is separately qualified; unavailable mandatory evidence blocks its release/cutover claim. Event injection is not advertised as OS IME testing. Cross-engine comparison is used only for outcomes the contract says are equal.

### U7 — Complete lifecycle, persistence, and the consumer API

**Outcome:** the candidate is a usable library with explicit failure and ownership behavior.

- Implement simple create/load/attach/use/save/release flows around the established facts. Derive readiness states from necessary meaning; do not copy today's flags without identifying their distinct legal operations.
- Default history, awareness, and paragraph attribution are composed once. Network and storage adapters remain selectable because environment-specific I/O is not required merely to edit a document.
- Port websocket and IndexedDB behavior, admission, version handling, delayed hydration, reconnect, crash/restart, and pending-update preservation. Receiving data, applying it, and persisting it are separate acknowledgements.
- Validate untrusted payloads at entry. Unknown/incompatible data must be rejected or retained under an explicit contract, never normalized into plausible data loss.
- Design the public surface from representative consumers: headless editing, Svelte editor, shared document with two views, custom block/mark, clipboard, DND/menu command, provider attach, and save/load. Expose domain operations rather than raw storage necessities.
- Maintain API compatibility through narrow adapters where cheap. Inventory and explicitly decide any expensive legacy or raw-engine surface; do not remove it by assuming it is unused.

**Gate:** packed consumers compile and run outside repository aliases. Existing supported data enters without destructive mutation. Failure, disposal, readonly, and multiple-view scenarios have behavioral tests. Public/wire changes have a concrete decision and migration path before cutover.

### U8 — Prove compression and optimize measured causes

**Outcome:** the candidate simplifies both current work and representative extensions.

- Reconcile the deletion ledger against actual code. Delete obsolete candidate paths after proof. Do not count moved code, shorter names, generated declarations, or removal of the preserved reference as architectural savings.
- Freeze the candidate source before implementing the E1/E2 consumer extensions reserved in U1. Implement each, then their combination with passive reference recovery, and record the complete source delta. Their exact consumer integrations must not already exist in the candidate. Zero production changes is valid evidence of composition; extra fixtures alone must not be reported as a new capability implementation. These probes demonstrate only the specified extensions, not cheap arbitrary future features.
- Record which authoritative rules and owners must change. A justified browser adapter change is acceptable; a second definition of document ownership or reference recovery fails the extension gate.
- Benchmark equivalent feature sets and lifecycle states. Separate default document, representative Svelte editor, provider-equipped editor, and raw-engine entry footprints. Do not add entry-point compressed sizes as if they were one application.
- Profile before optimizing. Candidate opportunities include span representation, scoped ownership/order indexes, batched construction, mark-run projection, and targeted DOM updates. Every cache names source/invalidation; every optimization reruns its semantic witnesses.
- Prune vendor types/algorithms only after checking public exports, decoder/registration reachability, migrations, old stored data, undo, and native attribution compatibility. Preserve provenance/licenses and reproducible generated declarations. If retained code is required only for a compatibility entry, report that footprint separately.

**Gate:** actual decision count and repeated work decrease in the target paths; production maintenance footprint and measured consumer/runtime costs meet the declared thresholds below. Improvements are attributed to changes, not to omitted capabilities or a different document workload.

### U9 — Run finite independent qualification

**Outcome:** a scoped acceptance decision for one final source, with explicit limits.

- Run the complete boundary matrix, sensitivity canaries, bounded generated campaigns, reference/candidate comparisons where applicable, and browser programs described below.
- One adversarial review attacks ownership, lifetimes, contract independence, and interaction combinations. Reviewers receive the contract before the candidate implementation. They do not invent expected values from production output.
- Focused tests run during repairs. Run full relevant suites on the final integrated source. A failed gate leads to a bounded correction and rerun of affected evidence; it does not automatically expand the feature scope or seed budget.
- Count repair rounds across the integrated candidate, not separately per reported distinction. A round covers a failed qualification checkpoint, its bounded set of corrections, and the resulting requalification. At the predeclared aggregate limit, report the remaining minimized cases, changed assumptions, and cost of continuing; obtain an explicit continue/redesign decision before another round. Renaming the failure family does not reset the count. Unresolved mandatory defects remain failures, not qualified exceptions created to meet the limit.
- Record unavailable environments and unresolved failures. Do not relabel them as passes or claim arbitrary-execution correctness from finite simulation.

**Gate:** all mandatory scenarios and intended canary failures pass; no known in-scope content-loss, divergence, stranded-input, or unauthorized-write defect remains; performance/compatibility decisions are explicit. Failure to meet a criterion is visible in the acceptance report.

### U10 — Replace reversibly and retire the old runtime

**Outcome:** consumers can use the candidate and the old implementation is no longer an accidental second authority.

- Produce a reviewable migration/cutover package before any irreversible action: compatibility table, converted fixture results, old-byte preservation, mixed-version behavior, rollback boundary, and source-identified package.
- If encoding is compatible, prove update interoperability in both directions for the supported surface. If not, define a new generation and explicit admission/version boundaries. Never join incompatible peers to the same room and hope semantic projection repairs it.
- Convert copies of saved data, retaining originals. Preserve supported IDs, properties, marks, pending causal information, attribution, and lineage according to the migration contract. A JSON export/import is not automatically a history- or collaboration-preserving migration.
- A rollback may require retaining new-format edits or a reverse converter; selecting the old UI does not make newer encoded data readable. State the actual limit.
- Switch the demo and package consumers in a controlled local cutover, run final packed-consumer smoke tests, and remove the old runtime only after the replacement gate is met. Retain the small independent specification tests, not an indefinite duplicate production stack.
- Update public docs, actual architectural decisions, and applicable project guidance. Archive superseded status claims without claiming their old results apply to the candidate.

**Gate:** the accepted compatibility/migration route works on representative saved documents and consumer code; supported capabilities remain; removal is genuine and accounted for. Publishing or destructive migration follows explicit user authorization.

## 9. Mandatory behavior matrix

These families are acceptance requirements. U1 assigns exact outcomes and stable fixture IDs; cases must not be left to chance in a random generator.

The following intended outcomes are already concrete from the preceding discussion. They are seed contracts for the design, not outputs to infer from a candidate:

| Before and action                                                                                                                      | Required result                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Split `alphaHello` after `alpha`. B selects the start of `Hello`. A appends `X` to `alpha`; deliver; B types `Z`.                      | `alphaX` / `ZHello`; B does not type in the predecessor.                                            |
| Same split and B selection. A inserts `X` at `Hello@0`; deliver; B types `Z`, using the agreed left insertion affinity.                | `alpha` / `ZXHello`; block-start membership must not reverse the affinity.                          |
| Same split and B selection. A joins the paragraphs; deliver; B types `Z`.                                                              | `alphaZHello`; B follows the boundary into the joined content.                                      |
| `[alpha, Hello, omega]`, B inside `Hello`. A deletes that block; deliver; B types `Z`.                                                 | `[alpha, Zomega]` under the forward-editable-seam policy; no caret on a dead object.                |
| A deletes all document content while B has a selection there; replacement editing space is not yet mounted; settle and let B type `Z`. | One editable paragraph containing `Z`; logical recovery does not depend on a pre-existing DOM node. |
| Split `alphaHello`, then compose provisional `n` to committed `に` at the beginning of `Hello`.                                        | `alpha` / `にHello`; no `nにello`, lost original character, or duplicated provisional input.        |
| Initial `abc`: A inserts `X` after `a`; B concurrently appends `Y`; synchronize; A undoes its insertion.                               | `abcY`; undo does not remove B's unrelated addition.                                                |

U1 specifies the remaining conflict outcomes and consumer policies before implementation. A browser adapter may execute a case differently, but it cannot silently change a fixed semantic result to accommodate its storage representation.

| Family                 | Required cases                                                                                                                                                | Observe                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Boundary continuity    | Directly constructed versus split-derived `alpha` / `Hello`; caret at `Hello@0`; predecessor append, target prepend, same-gap insertion, predecessor deletion | Intended editing space, affinity, exact continued typing                                   |
| Split/join             | Start/middle/end/empty; marked seam; atom boundary; nested placement; remote edits on both sides; concurrent split/join                                       | Content, order, relevant identities, marks, children, references                           |
| Delete ranges          | All endpoint shapes; forward/reversed; nonadjacent; nested ancestor/descendant; atom/isolated boundary; whole document                                        | Exact tree, preserved unselected content, valid editable continuation                      |
| Move                   | Before/after/inside; nest/unnest; group order; concurrent competing placement; cycles; delete versus move; escaped descendant                                 | One allowed visible occurrence, reachability, order, continued interaction                 |
| Reference consumers    | One target used by local selection, remote presence, historical bookmark, and a non-shipping annotation probe                                                 | Same resolution facts, distinct documented recovery; no invented presence                  |
| Reference availability | Missing dependencies; target deleted; target moved; reload; undo resurrection; permitted compaction                                                           | No conflation of unavailable/deleted; stated retention limits                              |
| Recovery topology      | Forward/backward editable neighbor; leading/trailing noneditable descendants; dead ancestor; replacement paragraph not mounted                                | Logical destination before binding, correct typing after binding                           |
| Selection races        | Object/ID lookup; rejected/detached lookup; newer same/different-position gesture; reversed range; one/two dead endpoints; focus switch; teardown             | No unauthorized write at any exit; whole selection shape                                   |
| Formatting             | Valued marks; overlapping removal; typing marks at empty caret; atom separators; remote format at boundary; split/join with marks                             | Canonical content and intended inheritance, no reference movement from styling alone       |
| Composition            | Replace selected text; split then compose; remote insert before/same gap; move/delete destination; cancel; focus interruption                                 | Exact provisional/committed policy, no duplication/loss, history grouping, final selection |
| History                | Local edit → remote edit → undo/redo; move and split with remote content; deletion plus remote restructuring; same actor/two sessions; two shared views       | Selective effect, unrelated remote preservation, replica/reload agreement                  |
| Attribution/lineage    | Actor handoff; no-op; split/join; children replacement; deletion; undo/redo; concurrent entries; depth disagreement; identity reincarnation                   | Expected records and displaced snapshots; retention convergence; encoded cost              |
| Admission/lifecycle    | Empty versus awaiting sync; invalid/unknown data; two views; borrowed resource; readonly; dispose during pending work                                         | No accidental seed/write, clear refusal, correct cleanup authority                         |
| Transport/persistence  | Duplicates, reorder, held release, reconnect, batching, late join, restart, persistence failure, unknown wire generation                                      | Correct convergence and durability claims; selection checked at delivery boundaries        |

High-risk combinations are mandatory: split × composition × remote insert; nested deletion × passive selection × delayed mount; join × move × undo; marked atom × nested DND × remote recovery. Use pairwise coverage for other secondary dimensions rather than pretending a full Cartesian product is practical.

Sequential equivalence across construction histories is checked under a stated mapping of corresponding semantic occurrences. Do not require different concurrent histories to have identical causal bytes or identical conflict outcomes merely because their current text looks the same.

## 10. Testing architecture and bounded campaigns

### Independent expected behavior

- Keep the small reference model focused on explicit semantic relationships. It does not need optimized encodings, browser rendering, or every public helper.
- Shared fixture types and neutral parsers are permitted. Shared decision algorithms for ownership, recovery, deletion results, or conflict winners are not an independent oracle.
- Wire replay checks integrity/convergence, not user intent. Production anchor resolution checks integration, not the correctness of the anchor's meaning.
- Assert exact trees, marks, data, relevant identities, selected endpoints, and continuation. Do not use flattened strings as a substitute for structural correctness.
- Inject canaries for wrong-but-converged ownership, no-op commands, delayed content corruption, dropped unselected children, mark loss, stale length/parent evidence, vanished selection during release, stale deferred writes, duplicate input, and unintended capture of remote undo work. Each must fail for its intended reason; valid controls must pass.

### Three complementary lanes

1. **Finite semantic exploration:** for the small two-/three-peer cases, enumerate the causally permitted delivery orders and selected batchings. State the operation/state bounds and equivalences used to reduce schedules. This is bounded exploration, not a theorem about unlimited execution.
2. **Controlled headless command simulation:** run actual semantic commands with controlled randomness, identities, logical clocks, deliveries, and the deferred queues the candidate uses. Prove fresh-process trace and semantic checkpoint equality. If queues remain real, describe that limitation instead of calling a clock mock a virtual event loop.
3. **Real browser qualification:** run named input/collaboration programs and seeded schedules on all three engines. Track native evidence and event provenance. Real OS IME/device qualification is separate from synthetic composition dispatch and WebKit automation.

Distinguish **observation checkpoints** from **settlement barriers**. Ordinary isolated-command programs settle local deferred effects before checking their independently computed expected result, then deliver and settle/check remote effects. This order is not imposed on race programs.

Race programs deliberately deliver remote work, introduce a newer gesture, commit/cancel composition, or complete a mount while other callbacks are pending. Assert only the contract's immediate guarantees at intermediate observations; assert the whole interleaved program's independently specified result at its declared final settlement barrier. Do not compare an isolated command's expected tree with a state legitimately changed by an intervening action. Keep one delayed-corruption canary for settled commands and a separate stale-write canary for interleaved programs; one must not be weakened to accommodate the other.

Mandatory race witness: delete a selected destination and pause before its replacement binds; deliver another relevant remote edit; introduce a newer gesture (including an identical numeric position); then release the old binding/restore callback. The old attempt must not acquire authority over the new intent. Use controlled callback/mount seams where available rather than timing sleeps. In real browsers, record observed event ordering and the narrower reproducibility claim.

At release/reconnect/heal, compare prior and post selection presence and shape even when the network step is inside a race program. An initially unselected peer need not acquire a selection. An explicit reload resets the baseline under its own contract. Pending DOM work is permitted before a declared barrier; a logically dead or unauthorized target is not excused merely because some work remains pending.

Settlement must account for finite nested microtasks, timers, frames, cancellation, and callbacks that schedule more work. At the final barrier, transport and deferred effects reach the declared fixed point together. Bounded nonsettling work fails with evidence. Out-of-horizon policy timers may be excluded only when they cannot change the asserted result under the stated contract.

### Fixed campaign budget

- Initial representation qualification: all mandatory slice fixtures plus **32 fixed seeds × 24 semantic actions**, including a named three-peer held-delivery program.
- Final headless qualification: **128 fixed seeds × 64 actions**, spanning two and three peers, with realized action/conflict/actor coverage reported.
- Final browser qualification: the retained default corpus plus **12 fixed collaboration seeds × 32 actions per engine**, and the named high-risk composition/recovery programs. Engine-specific unit contracts remain explicit.
- Run one fresh-process determinism comparison on representative controlled scenarios, with payload identity, action arguments, delivery decisions, and semantic outcomes in the trace. Exclude uncontrolled diagnostic timing from deterministic hashes.

These are acceptance budgets, not confidence percentages. Pin seeds and configuration before running the final candidate. Coverage holes are filled with explicit missing scenarios, not by reporting a larger nominal number of seeds. Minimize failures while preserving their class and retain replay artifacts outside runner-cleaned directories.

### Implementing the rewrite through the existing tests and DST

The tests are accumulated evidence to preserve, not an architecture the candidate must imitate. Start with a small inventory rather than copying every test into a second tree:

| Existing evidence                                                                                                        | Reuse                                                                            | Adapt or keep separate                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| JSX document fixtures and operation cases under `src/tests/fixtures/model/`                                              | Inputs, independently accepted behavior, exact trees/marks/identity expectations | Drivers that construct `Block`/`Text` or patch old selection state                                                                  |
| `src/tests/fixtures/dom/command-programs.test.tsx`, `command-simulation.test.tsx`, and selection/composition regressions | Named command and collaboration programs, exact continuation outcomes            | Candidate command dispatch, mount, and observation bindings                                                                         |
| `src/tests/crdt/harness/peer-set.ts`, `rng.ts`, `trace.ts`, and determinism probes                                       | Explicit delivery concepts, random schedules, trace/minimization evidence        | Engine-specific creation, identity injection, snapshot/update handling, and clock seams                                             |
| `src/tests/fixtures/dom/command-schedule-program.ts`                                                                     | The small independent flat-text expectation model within its stated domain       | Its current root/first-text targeting and settled-per-command schedule; do not claim it already covers arbitrary structure or races |
| `tests/editor-dst/` and `tests/editor-dom/`                                                                              | Browser actions, shaped fixtures, network fault episodes, regression artifacts   | Test-page bindings and dumps coupled to current wrappers, facade, or anchor shapes                                                  |
| Vendor tests, packed consumers, and `bench/`                                                                             | Retained-engine invariants, actual packaging/API contracts, comparable workloads | Engine-internal tests apply only to retained mechanisms; new primitives need their own witnesses                                    |

Classify each relevant existing test as a behavior contract, an implementation-specific invariant, or disputed/insufficient evidence. Port the first class. Keep the second with the mechanism it proves rather than rebuilding that mechanism to keep its test green. Resolve the third from intended behavior and canaries. Every retired test gets a reason or a replacement witness; blanket exclusions are not a passing candidate.

Create only the thin test drivers needed for two real implementations. They translate fixture setup, logical commands, observations, and delivery into each implementation's actual public/production path. They must not implement deletion, recovery, normalization, or conflict decisions themselves. Reuse neutral fixtures, not production resolvers as expectations. Keep candidate routing outside shipping exports until qualified; do not add a permanent runtime framework merely to host the comparison.

Run the reference and candidate in separate replica groups. Within each group, create one seed document and hydrate its peers from that group's encoded seed so they share its causal history. Between implementations, replay the same **logical program**, not necessarily the same bytes, internal IDs, packet indexes, or number of engine transactions. Explicit mixed-version byte interoperability is tested separately at its compatibility gate.

Record semantic targets and creation-event mappings in reusable schedules. The existing generators may choose the next target from live wrapper state; the same RNG seed alone does not guarantee two implementations receive the same logical actions. Resolve those choices against the independent scenario state, or record the realized semantic program and fail when a required precondition diverges. Adapters must not silently clamp an invalid target into a different operation. Normalize only representational differences permitted by the contract; never erase a wrong owner, lost child, mark, or opposite side of an inline atom.

Use three separate comparisons: candidate versus independent expected semantics; peers within one implementation versus each other; candidate versus the preserved reference on agreed behavior. Agreement in the latter two does not override failure in the first. Known reference defects remain explicit exceptions with correct candidate expectations, not a reason to weaken the oracle.

Implement one vertical slice at a time using this loop:

1. Select the contract and its independent witnesses, including one known failure and its neighboring case.
2. Run them on the preserved reference; record behavior and any acknowledged exception.
3. Implement the smallest candidate behavior through the chosen semantic owners.
4. Run focused unit/model checks, then actual multi-peer command programs and the relevant browser input probe.
5. Exercise both settled commands and deliberate interleavings; add bounded generated schedules only over the supported model domain and report realized coverage.
6. Minimize a failure, classify product/harness/contract error with evidence, and preserve the fixed case as a named regression. A recurring missing distinction invokes the redesign checkpoint.
7. Measure the targeted work and update the deletion ledger before expanding the slice.

Unsupported candidate actions must be listed as incomplete, not silently skipped or redirected to the old implementation. Each slice may have a focused passing gate; overall acceptance still requires every mandatory behavior. After the minimal split/reference/undo/composition slice, expand through U4–U7. Optimize in U8 only once the candidate has independent correctness evidence. Keep full-suite runs for integrated checkpoints and final qualification rather than after every local edit.

The first runnable target is deliberately difficult: split a paragraph, keep a passive peer at the new start, edit either side, join/delete/move, undo after remote work, compose there, and continue typing. Run it at root, nested, and beside an inline atom. This tests whether the representation eliminates the old ambiguity before most of the replacement is written.

## 11. Measurement and acceptance

U0 establishes a fixed reference. U2/U3 select the two primary structural costs to reduce before optimization begins. U8 reports the candidate against those same costs; do not change the target to whichever metric improved.

| Dimension             | Required accounting                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maintained size       | Handwritten library, vendored source, compatibility code, generated declarations, tests, and docs separately; count new shared code wherever placed      |
| Independent decisions | Who decides ownership, reference meaning, recovery, write admission, deletion semantics, no-op effects, and retention before/after                       |
| Extension cost        | Semantic owners/rules changed by the two withheld extensions and their combination; explain every new distinction                                        |
| Shipped size          | Packed artifact, minified consumer JS, gzip/Brotli; representative default and provider graphs; raw-engine compatibility graph separately                |
| Time                  | Headless edit, projection, selection, render/settlement, mount, load, encode, sync; p50/p95 and uncertainty                                              |
| Memory/work           | Allocation where measurable; heap retained versus allocation rate separately; traversed spans/blocks, reconstructed runs, scans, callbacks, publications |
| Storage/wire          | Live semantic payload, full encoded document, incremental update stream, persistence rows, and retained undo/lineage separately                          |

Workloads include a small document; 1k and 5k blocks; a 100k-character paragraph; marked/atom-fragmented text; split-shared and directly built equivalents; nested structures; and churn with actor switches, delete/undo, and offline reconciliation. Use equivalent content, capabilities, history settings, and seed across implementations. Historical timings in this repository are context, not current targets.

**Maintenance acceptance:** the named redundant machinery is retired, all replacement costs are counted, and the total maintained production footprint decreases at equivalent supported scope. If it grows, record a failed default compression gate and request explicit acceptance of the concrete correctness/performance/maintenance tradeoff before replacement. Moving code, splitting files, deleting the comparison editor, or excluding compatibility from only one side does not satisfy this rule.

**Default performance acceptance:** no statistically credible material regression in an untouched representative lane; treat a repeatable >10% degradation in p95 latency, allocation, or consumer bytes as a review trigger, not permission to hide it in averages. Require a reduction beyond measured noise in the two preselected primary structural costs. If this cannot be achieved with the required behavior, present the tradeoff before replacement rather than inventing an improvement claim. There is no arbitrary percentage LOC target; real net reduction and explicit decisions on failed criteria remain required.

Use repeated isolated measurements and record order/noise. Extra full-suite runs are not performance evidence. No optimization is accepted by dropping composition, history, attribution, providers, or compatibility from only one side of the comparison.

## 12. Repair limits, decision gates, and orchestration

- Each experiment gets its mandatory witnesses and one independent adversarial review before expansion. Review the representation and authority boundaries, not merely style.
- Permit at most **two repair rounds for the same missing distinction** within a representation experiment. If a third fix would make another consumer remember that distinction, return to U1/U2 and reconsider the representation. This is a checkpoint for repeated design failure, not a ban on fixing unrelated ordinary bugs.
- Evaluate at most two candidate representations in U2. If neither passes, produce the smallest unresolved counterexample and an explicit next design decision; do not launch an open-ended third rewrite.
- Apply the aggregate U9 repair checkpoint frozen before U4 (default: three rounds) in addition to the per-distinction limit. Exhaustion requires a concrete continue/redesign decision with remaining counterexamples; it neither declares success nor permits new failure labels to restart the budget.
- Do not expand random budgets to compensate for an oracle blind spot. Fix the missing independent assertion and add the named witness.
- Once a unit meets its gate, move on. Once U9 meets the acceptance contract, stop speculative adversarial expansion. Newly confirmed in-scope critical defects still block acceptance; cosmetic ideas do not.
- Before U10, one report states: accepted contracts, chosen representation, removed decisions, retained complexity, measurements, compatibility, known limits, and rollback conditions. A rejected candidate is an honest result, not a green rewrite.
- If delegating, use disjoint production ownership: contract/oracle review can run independently; causal semantics has one writer; interaction/browser work waits for its semantic interface; packaging/measurement can prepare concurrently. One integrator verifies combined behavior. Subagent summaries are not qualification evidence.

## 13. Current seams and commands for reconnaissance

These paths locate evidence. They do not prescribe the new architecture. Recheck names and active changes before implementation.

- `src/lib/crdt/{document,edytor-doc,nodes}.ts`: assembled API, semantic operations, transactions, admission and service wiring.
- `src/lib/crdt/{placement,text}/`: current placement/content representation, ownership, runs, and indexing.
- `src/lib/crdt/attribution/`: paragraph authorship and bounded displaced-state lineage.
- `src/lib/crdt/{providers,protocols,migration}/` and `vendor/yjs/UPSTREAM.md`: compatibility, integration, retained source and patches.
- `src/lib/{block,text,selection}/`, `edytor.svelte.ts`, `edytor.utils.ts`, `events/`, and `history/`: wrapper, input, selection, and history decisions to inventory.
- `src/lib/components/`, `plugins/`, `collaboration/`: rendering, extension points, awareness, DND and menus.
- `src/tests/crdt/`, `src/tests/fixtures/dom/command-*`, `tests/editor-dst/`, `tests/editor-dom/`, `tests/packed-consumer/`, and `bench/`: reusable validation and measurement infrastructure.
- Existing ADRs, `docs/editor-delete-contract.md`, `docs/archive/selection-contract-consolidation-handoff.md`, and `docs/archive/library-vendor-compression-handoff.md`: prior requirements/evidence. Reconcile overlap; do not execute every old handoff as a new prerequisite.

Commands verified as present in the package scripts when writing this plan; their existence is not a fresh passing result:

```sh
pnpm check
pnpm lint
pnpm test -- --run
pnpm test:dom
pnpm test:crdt
pnpm test:typecheck
pnpm test:dom:typecheck
pnpm test:integration:serial
pnpm test:dst
pnpm build
pnpm bench:crdt
pnpm bench:browser
```

Inspect `tests/packed-consumer/run.sh` and the active configs before using the corresponding consumer/browser lanes. Candidate-specific commands must be added and documented during implementation, not invented as if they already exist. Run focused checks while editing and the required full lanes on the final source once integrated.

## 14. Required handoff report

The implementing agent reports **Outcome**, **Validation**, and **Risks**. Include:

- Required behavior, chosen relationships, and rejected alternatives with the counterexamples that rejected them.
- The fact/authority/lifetime inventory and completed deletion ledger.
- Exact source identity and evidence paths; command results, realized scenario coverage, canary sensitivity, and unavailable environments.
- Maintained-size, shipped-size, time, memory/work, wire/storage, and extension-cost comparisons with measurement limits.
- Compatibility/migration/rollback decision and the precise remaining qualification boundary.

The acceptance question is not whether the code looks cleaner. It is whether the necessary relationships are represented once, their authority lasts only as long as it should, and consumers can compose the behavior without rediscovering the same decisions.
