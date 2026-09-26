# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: editor-dom/collaboration-websocket-3client.spec.ts >> three-client collaboration over a real websocket relay >> a refused schema handshake claims no sync, then recovers when a clean peer joins
- Location: tests/editor-dom/collaboration-websocket-3client.spec.ts:565:2

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: false
Received: true

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Test source

```ts
  542 | 
  543 | 			// B's undo removes its marked '-B' — the mark dies with the run it
  544 | 			// was attached to; A's reverted state and C's '-C' are untouched.
  545 | 			await pageB.evaluate(() => {
  546 | 				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
  547 | 				edytor.undoManager.undo();
  548 | 			});
  549 | 			const afterUndoB = await expectConverged3(pageA, pageB, pageC);
  550 | 			expect(afterUndoB.children.map(blockText)).toEqual(['alpha', 'beta-C', 'gamma']);
  551 | 			expect(textRuns(afterUndoB.children[2])).toEqual([{ text: 'gamma', marks: null }]);
  552 | 			// Adjacent unmarked runs coalesce in serialization — 'beta-C' is a
  553 | 			// single markless run.
  554 | 			expect(textRuns(afterUndoB.children[1])).toEqual([{ text: 'beta-C', marks: null }]);
  555 | 
  556 | 			issuesA.assertClean();
  557 | 			issuesB.assertClean();
  558 | 			issuesC.assertClean();
  559 | 		} finally {
  560 | 			await closeClients3(clients);
  561 | 			await relay.close();
  562 | 		}
  563 | 	});
  564 | 
  565 | 	test('a refused schema handshake claims no sync, then recovers when a clean peer joins', async ({
  566 | 		browser
  567 | 	}, testInfo) => {
  568 | 		const relay = await startOpaqueRelay();
  569 | 		const room = roomName();
  570 | 		let clients: SocketClients3 | undefined;
  571 | 		let rogue: Awaited<ReturnType<typeof startRoguePeer>> | undefined;
  572 | 		try {
  573 | 			// The rogue member joins FIRST so it answers the joining client's
  574 | 			// SyncStep1 with a v99 SyncStep2 before any clean peer can.
  575 | 			rogue = await startRoguePeer(relay, room);
  576 | 			expect(relay.socketCount(room)).toBe(1);
  577 | 
  578 | 			const baseURL = testInfo.project.use.baseURL;
  579 | 			const contextA = await browser.newContext({ baseURL });
  580 | 			const pageA = await contextA.newPage();
  581 | 			clients = { contextA, pageA };
  582 | 			const issuesA = trackPageIssues(pageA);
  583 | 
  584 | 			// Plain navigation — the refused client never reaches `synced`, so
  585 | 			// `waitForEditorReady`'s block-visibility gate would time out by
  586 | 			// design. The provider exists right after mount, before any sync.
  587 | 			await pageA.goto(
  588 | 				`/test/dom?scenario=collab&collabws=${room}&wsserver=${encodeURIComponent(relay.url)}` +
  589 | 					`&wsresync=200&wsbackoff=400`,
  590 | 				{ waitUntil: 'domcontentloaded' }
  591 | 			);
  592 | 			await expect
  593 | 				.poll(() =>
  594 | 					pageA.evaluate(() =>
  595 | 						Boolean((window as Window & { __EDYTOR_COLLAB__?: unknown }).__EDYTOR_COLLAB__)
  596 | 					)
  597 | 				)
  598 | 				.toBe(true);
  599 | 
  600 | 			// Capture the refusal signals emitted on the provider.
  601 | 			await pageA.evaluate(() => {
  602 | 				const w = window as Window & {
  603 | 					__EDYTOR_COLLAB__?: { provider?: any };
  604 | 					__WS_ERRORS__?: { mismatches: any[]; messageErrors: string[] };
  605 | 				};
  606 | 				w.__WS_ERRORS__ = { mismatches: [], messageErrors: [] };
  607 | 				w.__EDYTOR_COLLAB__!.provider.on('schema-mismatch', (detail: any) =>
  608 | 					w.__WS_ERRORS__!.mismatches.push(detail)
  609 | 				);
  610 | 				w.__EDYTOR_COLLAB__!.provider.on('message-error', (error: unknown) =>
  611 | 					w.__WS_ERRORS__!.messageErrors.push(String((error as Error)?.message ?? error))
  612 | 				);
  613 | 			});
  614 | 			const readErrors = () =>
  615 | 				pageA.evaluate(
  616 | 					() =>
  617 | 						(window as Window & { __WS_ERRORS__?: { mismatches: any[]; messageErrors: string[] } })
  618 | 							.__WS_ERRORS__ ?? { mismatches: [], messageErrors: [] }
  619 | 				);
  620 | 
  621 | 			// The rogue answers each SyncStep1 (initial + every 200 ms resync)
  622 | 			// with the v99 SyncStep2 — each is staged, refused, and signaled.
  623 | 			await expect.poll(() => rogue!.replies(), { timeout: 10000 }).toBeGreaterThan(0);
  624 | 			await expect
  625 | 				.poll(async () => (await readErrors()).mismatches.length, { timeout: 10000 })
  626 | 				.toBeGreaterThan(0);
  627 | 			const errors = await readErrors();
  628 | 			expect(
  629 | 				errors.mismatches.some(
  630 | 					(detail) => detail?.problem?.kind === 'unsupported' && detail?.problem?.version === 99
  631 | 				)
  632 | 			).toBe(true);
  633 | 			expect(errors.messageErrors.some((m) => m.includes('unsupported schema version 99'))).toBe(
  634 | 				true
  635 | 			);
  636 | 
  637 | 			// No false synced: a full second of refused handshakes (≥4 resync
  638 | 			// cycles) leaves provider.synced AND edytor.synced false, renders
  639 | 			// zero blocks, and never admits the marker block.
  640 | 			await pageA.waitForTimeout(1000);
  641 | 			expect(await getCollabProvider(pageA)).toMatchObject({ wsconnected: true, synced: false });
> 642 | 			await expect
      |    ^ Error: expect(received).toBe(expected) // Object.is equality
  643 | 				.poll(() =>
  644 | 					pageA.evaluate(() =>
  645 | 						Boolean((window as Window & { __EDYTOR__?: any }).__EDYTOR__?.synced)
  646 | 					)
  647 | 				)
  648 | 				.toBe(false);
  649 | 			await expect(pageA.locator('[data-edytor-block="true"]')).toHaveCount(0);
  650 | 			expect(JSON.stringify(await readValue(pageA))).not.toContain('evil-v99');
  651 | 
  652 | 			// Recovery: clean peers join the same room — their SyncStep2 replies
  653 | 			// stage clean, apply, and legitimately flip `synced` on A.
  654 | 			const contextB = await browser.newContext({ baseURL });
  655 | 			const contextC = await browser.newContext({ baseURL });
  656 | 			clients.contextB = contextB;
  657 | 			clients.contextC = contextC;
  658 | 			const pageB = await contextB.newPage();
  659 | 			const pageC = await contextC.newPage();
  660 | 			clients.pageB = pageB;
  661 | 			clients.pageC = pageC;
  662 | 			const issuesB = trackPageIssues(pageB);
  663 | 			const issuesC = trackPageIssues(pageC);
  664 | 			await Promise.all([openSocketPage(pageB, room, relay), openSocketPage(pageC, room, relay)]);
  665 | 
  666 | 			await expectProviderState(pageA, { wsconnected: true, synced: true }, 15000);
  667 | 			const converged = await expectConverged3(pageA, pageB, pageC);
  668 | 			expect(converged.children.map((block) => block.id)).toEqual([
  669 | 				'collab-b1',
  670 | 				'collab-b2',
  671 | 				'collab-b3'
  672 | 			]);
  673 | 			expect(JSON.stringify(converged)).not.toContain('evil-v99');
  674 | 
  675 | 			issuesA.assertClean();
  676 | 			issuesB.assertClean();
  677 | 			issuesC.assertClean();
  678 | 		} finally {
  679 | 			rogue?.close();
  680 | 			await closeClients3(clients);
  681 | 			await relay.close();
  682 | 		}
  683 | 	});
  684 | });
  685 | 
```