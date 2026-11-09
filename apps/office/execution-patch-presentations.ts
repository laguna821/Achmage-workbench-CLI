/** Restore transient state into the original HTML/PPTX loader and call its own
 * send path. The original document tools, serializers and explicit decisions stay
 * in charge; source changes at these pinned boundaries fail the transform. */
export function patchPresentationExecutions(code: string, id: string, root: string, module: string): string {
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2) throw new Error(`Original presentation executor boundary changed: ${id}: ${before.slice(0, 100)}`);
    code = code.replace(before, after);
  };
  const helper = `${module.slice(0, module.lastIndexOf("/"))}/execution-presentations.ts`;
  const imports = `import { registerOriginalExecutor, isOfficeExecutor, askOfficeExecutionQuestion, withOfficeExecution, officeExecutionSignal, optionalOfficeExecution } from ${JSON.stringify(module)};\nimport { captureHtmlIdentity as wbCaptureHtmlIdentity, restoreHtmlIdentity as wbRestoreHtmlIdentity, capturePresentationSelection as wbCapturePresentationSelection, restorePresentationSelection as wbRestorePresentationSelection, askPresentationClarification as wbAskPresentationClarification, askHtmlExecutionBrief as wbAskHtmlExecutionBrief, lockPresentationSurface as wbLockPresentationSurface } from ${JSON.stringify(helper)};\n`;

  if (id === `${root}/apps/html/src/renderer/App.tsx`) {
    replace("    getSnapshot: () => ({ text: textRef.current }),", `    getExecutionSelection: () => ({ primary: selectedSidRef.current, extras: [...extraSidsRef.current], brief: briefRef.current }),
    restoreExecutionSelection: (selection) => {
      const map = getMap();
      if ((selection.primary !== null && !map.bySid.has(selection.primary)) || selection.extras.some(sid => !map.bySid.has(sid))) throw new Error('HTML 선택 위치를 복원할 수 없습니다.');
      wbExecutionFlushSync(() => {
        selectSid(selection.primary, { reveal: true });
        setExtras([...selection.extras]);
        briefRef.current = selection.brief;
      });
    },
    getSnapshot: () => ({ text: textRef.current }),`);
    return `import { flushSync as wbExecutionFlushSync } from 'react-dom';\n${code}`;
  }

  if (id === `${root}/apps/html/src/renderer/ai/AiPanel.tsx`) {
    replace("  getSnapshot(): DocSnapshot", "  getExecutionSelection(): { primary: number | null; extras: number[]; brief: Brief | null }\n  restoreExecutionSelection(selection: ReturnType<HtmlAiDeps['getExecutionSelection']>): void\n  getSnapshot(): DocSnapshot");
    replace("      !sendGate.admit({", "      !isOfficeExecutor() && !sendGate.admit({");
    replace("  const loopRef = useRef<AgentLoop<DocSnapshot> | null>(null)", `  const wbExecutionAttachmentsRef = useRef<AttachmentMeta[]>([]);
  const wbExecutionStartRef = useRef<{ resolve(started: boolean): void; reject(error: unknown): void } | null>(null);
  const loopRef = useRef<AgentLoop<DocSnapshot> | null>(null)`);
    replace("    const sentAtts = attachmentsOverride ?? attachmentsRef.current", "    const sentAtts = attachmentsOverride ?? attachmentsRef.current\n    wbExecutionAttachmentsRef.current = sentAtts");
    replace("      loopRef.current?.cancel()\n      depsRef.current.clearHighlights()", "      wbExecutionStartRef.current?.reject(new Error('문서 실행 준비 중 편집기가 닫혔습니다.'))\n      wbExecutionStartRef.current = null\n      loopRef.current?.detach()\n      depsRef.current.clearHighlights()");
    replace(`            askClarification: (questions) =>
              new Promise((resolve) => {
                clarifyResolverRef.current = resolve
                setActiveClarify(questions)
              }),`, `            askClarification: (questions) =>
              new Promise((resolve, reject) => {
                clarifyResolverRef.current = resolve
                setActiveClarify(questions)
                if (isOfficeExecutor()) void wbAskPresentationClarification(questions, tGlobal('aiClarifyDecideAnswer')).then(answer => {
                  if (clarifyResolverRef.current !== resolve) return;
                  clarifyResolverRef.current = null; setActiveClarify(null); resolve(answer);
                }, error => {
                  if (clarifyResolverRef.current !== resolve) return;
                  clarifyResolverRef.current = null; setActiveClarify(null); reject(error);
                });
              }),`);
    replace(`            confirmBrief: (brief) =>
              new Promise((resolve) => {
                briefResolverRef.current = resolve
                setActiveBrief(brief)
              }),`, `            confirmBrief: (brief) =>
              new Promise((resolve, reject) => {
                briefResolverRef.current = resolve
                setActiveBrief(brief)
                if (isOfficeExecutor()) void wbAskHtmlExecutionBrief(brief).then(decision => {
                  if (briefResolverRef.current !== resolve) return;
                  if (decision.kind === 'confirmed') depsRef.current.onBriefConfirmed(decision.brief);
                  briefResolverRef.current = null; setActiveBrief(null); resolve(decision);
                }, error => {
                  if (briefResolverRef.current !== resolve) return;
                  briefResolverRef.current = null; setActiveBrief(null); reject(error);
                });
              }),`);
    replace(`    const keep = await new Promise<boolean>((resolve) => {
      partialResolverRef.current = resolve
      setActivePartial({ lines: outcome.html.split('\\n').length })
    })`, `    const keep = await new Promise<boolean>((resolve, reject) => {
      partialResolverRef.current = resolve
      setActivePartial({ lines: outcome.html.split('\\n').length })
      if (isOfficeExecutor()) void askOfficeExecutionQuestion('HTML 작성을 끝내지 못했습니다. 지금까지 작성한 ' + outcome.html.split('\\n').length + '줄을 유지할까요?').then(keep => {
        if (partialResolverRef.current !== resolve) return;
        partialResolverRef.current = null; setActivePartial(null); resolve(keep);
      }, error => {
        if (partialResolverRef.current !== resolve) return;
        partialResolverRef.current = null; setActivePartial(null); reject(error);
      });
    })`);
    const run = code.match(/        await loop\.run\(instruction \+ skillUse\.text, images\.length > 0 \? images : undefined[^\n]*\)/g);
    if (run?.length !== 1) throw new Error("Original HTML send completion boundary changed");
    replace(run[0]!, `${run[0]}\n        wbExecutionStartRef.current?.resolve(true)\n        wbExecutionStartRef.current = null`);
    replace("        patchLast({\n          streaming: false,\n          text: err instanceof Error ? err.message : String(err),", "        wbExecutionStartRef.current?.reject(err)\n        wbExecutionStartRef.current = null\n        patchLast({\n          streaming: false,\n          text: err instanceof Error ? err.message : String(err),");
    const marker = "  const stop = (): void => {";
    replace(marker, `  useEffect(() => registerOriginalExecutor({
    ready: () => Boolean(loopRef.current && depsRef.current.access.getMap()),
    capture: () => ({ format: 'html', data: {
      identities: wbCaptureHtmlIdentity(depsRef.current.access.getMap()),
      selection: depsRef.current.getExecutionSelection(), intent: intentRef.current,
      scope: lastScopeRef.current ?? null, queueRun: lastQueueRunRef.current,
      attachments: wbExecutionAttachmentsRef.current, sentAttachments: sentAttachmentsRef.current,
    } }),
    execute: async (instruction, state) => {
      if (state.format !== 'html') throw new Error('HTML 실행 상태가 아닙니다.');
      const data = state.data as {
        identities: Parameters<typeof wbRestoreHtmlIdentity>[1];
        selection: ReturnType<HtmlAiDeps['getExecutionSelection']>; intent: PageIntent;
        scope: AiScopeQuoteData | null; queueRun: boolean;
        attachments: AttachmentMeta[]; sentAttachments: AttachmentMeta[];
      };
      if (!loopRef.current || loopRef.current.busy) return false;
      wbRestoreHtmlIdentity(depsRef.current.access.getMap(), data.identities);
      depsRef.current.restoreExecutionSelection(data.selection);
      wbExecutionFlushSync(() => setIntent(data.intent));
      intentRef.current = data.intent;
      sentAttachmentsRef.current = data.sentAttachments;
      return new Promise<boolean>((resolve, reject) => {
        wbExecutionStartRef.current = { resolve, reject };
        if (!send(instruction, undefined, data.queueRun, data.attachments, data.scope ?? undefined)) {
          wbExecutionStartRef.current = null; resolve(false);
        }
      });
    },
    lock: wbLockPresentationSurface,
  }), []);

${marker}`);
    return `${imports}import { flushSync as wbExecutionFlushSync } from 'react-dom';\n${code}`;
  }

  if (id === `${root}/apps/slides/src/renderer/App.tsx`) {
    replace("                key={aiPanelKey}\n                slides={slides}", `                key={aiPanelKey}
                restoreExecutionSelection={(page, ids) => wbExecutionFlushSync(() => {
                  setCurrent(page); setSelectedIds(ids); setEditing(null);
                })}
                slides={slides}`);
    return `import { flushSync as wbExecutionFlushSync } from 'react-dom';\n${code}`;
  }

  if (id === `${root}/apps/slides/src/renderer/ai/deck-context-gate.ts`) {
    replace("  confirm(warning: ContextWarning): boolean", "  confirm(warning: ContextWarning): boolean | Promise<boolean>");
    replace("  allows(settings: S, system: string, user: string, run: AbortSignal | undefined): boolean", "  allows(settings: S, system: string, user: string, run: AbortSignal | undefined): Promise<boolean>");
    replace("  const answers = new WeakMap<AbortSignal, boolean>()", "  const answers = new WeakMap<AbortSignal, boolean>()\n  const pending = new WeakMap<AbortSignal, Promise<boolean>>()");
    replace("    allows(settings, system, user, run) {", "    async allows(settings, system, user, run) {\n      if (run?.aborted) return false\n      if (run && pending.has(run)) return (await pending.get(run)!) && !run.aborted");
    replace(`      let confirmed: boolean
      try {
        confirmed = options.confirm(warning) === true
      } catch {
        // a broken dialog declines: nothing is sent without a yes
        confirmed = false
      }
      if (run) answers.set(run, confirmed)
      return confirmed`, `      const confirmation = Promise.resolve().then(() => options.confirm(warning)).then(answer => answer === true, () => false)
      if (run) pending.set(run, confirmation)
      const confirmed = (await confirmation) && !run?.aborted
      if (run) { pending.delete(run); answers.set(run, confirmed) }
      return confirmed`);
    return code;
  }

  if (id === `${root}/apps/slides/src/renderer/ai/template-selection-state.ts`) {
    replace("  current(): TemplateSelection | null", "  current(): TemplateSelection | null\n  /** Restore an admitted executor's snapshot without rewriting the user's saved selection. */\n  restoreExecutionSelection(selection: TemplateSelection | null): void");
    replace("    current: () => current,", "    current: () => current,\n    restoreExecutionSelection: (selection) => { writes += 1; publish(structuredClone(selection)); },");
    return code;
  }

  if (id === `${root}/apps/slides/src/renderer/ai/AiPanel.tsx`) {
    replace("interface AiPanelProps {", "interface AiPanelProps {\n  restoreExecutionSelection: (page: number, ids: string[]) => void");
    replace("export function AiPanel({\n  slides,", "export function AiPanel({\n  restoreExecutionSelection,\n  slides,");
    replace("  const slidesRef = useRef(slides)", `  const wbRestoreSelectionRef = useRef(restoreExecutionSelection);
  wbRestoreSelectionRef.current = restoreExecutionSelection;
  const wbExecutionStartRef = useRef<{ resolve(started: boolean): void; reject(error: unknown): void } | null>(null);
  const wbExecutionCompleteRef = useRef<{ resolve(): void; reject(error: unknown): void } | null>(null);
  const wbExecutionSettingsRef = useRef<AiSettings | null>(null);
  const wbExecutionQcRef = useRef<boolean | null>(null);
  const wbExecutionQueueRef = useRef<EditQueueItem[] | null>(null);
  const wbSubmittedQueueRef = useRef<EditQueueItem[] | null>(null);
  const wbQueueTextRef = useRef<string | null>(null);
  const wbExecutionQueueErrorRef = useRef<unknown>(null);
  const slidesRef = useRef(slides)`);
    replace("      !sendGate.admit({", "      !isOfficeExecutor() && !sendGate.admit({");
    replace("      confirm: (warning) => window.confirm(aiContextConfirmText(getLang(), warning)),", "      confirm: (warning) => isOfficeExecutor() ? askOfficeExecutionQuestion(aiContextConfirmText(getLang(), warning)) : window.confirm(aiContextConfirmText(getLang(), warning)),");
    replace("    const runLlmAttempt = (", "    const runLlmAttempt = async (");
    replace(`    ): Promise<LlmResult> =>
      new Promise((resolve) => {
        if (signal?.aborted) {
          resolve({ ok: false, error: tGlobal('aiErrStopped'), errKind: 'stopped' })
          return
        }
        // declined: the model is not called, and 'stopped' keeps retry ladders from trying again
        if (!deckContextGate.allows(settings, system, user, signal)) {
          resolve({
            ok: false,
            error: aiRunErrorText(getLang(), { kind: 'context-limit' }) ?? tGlobal('aiErrStopped'),
            errKind: 'stopped',
          })
          return
        }
        const requestId = crypto.randomUUID()`, `    ): Promise<LlmResult> => {
      if (signal?.aborted) return { ok: false, error: tGlobal('aiErrStopped'), errKind: 'stopped' };
      if (!await deckContextGate.allows(settings, system, user, signal)) return {
        ok: false, error: aiRunErrorText(getLang(), { kind: 'context-limit' }) ?? tGlobal('aiErrStopped'), errKind: 'stopped',
      };
      if (signal?.aborted) return { ok: false, error: tGlobal('aiErrStopped'), errKind: 'stopped' };
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID()`);
    replace("      })\n    const runLlmOnce = async (", "      })\n    }\n    const runLlmOnce = async (");
    replace(`      askClarification: (questions: ClarifyQuestion[]) => {
        return new Promise<{ answers: string; cancelled?: boolean }>((resolve) => {
          clarifyResolverRef.current = resolve
          setActiveClarify(questions)
        })
      },`, `      askClarification: (questions: ClarifyQuestion[]) => {
        return new Promise<{ answers: string; cancelled?: boolean }>((resolve, reject) => {
          clarifyResolverRef.current = resolve
          setActiveClarify(questions)
          if (isOfficeExecutor()) void wbAskPresentationClarification(questions, tGlobal('aiClarifyDecideAnswer')).then(answer => {
            if (clarifyResolverRef.current !== resolve) return;
            clarifyResolverRef.current = null; setActiveClarify(null); resolve(answer);
          }, error => {
            if (clarifyResolverRef.current !== resolve) return;
            clarifyResolverRef.current = null; setActiveClarify(null); reject(error);
          });
        })
      },`);
    replace("  settingsRef.current = liveSettings", "  settingsRef.current = isOfficeExecutor() && wbExecutionSettingsRef.current ? wbExecutionSettingsRef.current : liveSettings");
    replace("    const items = editQueue ?? []", "    const items = wbExecutionQueueRef.current ?? editQueue ?? []\n    wbSubmittedQueueRef.current = structuredClone(items)");
    replace("    if (!sendGate.admitQueued(() => {})) return", "    if (!isOfficeExecutor() && !sendGate.admitQueued(() => {})) return");
    replace("    const shown = lines.join('\\n')", "    const shown = lines.join('\\n')\n    wbQueueTextRef.current = shown");
    replace(`        .catch(() => {
          runStartingRef.current = false
          queueRunResolverRef.current = null
          void finishHistoryBatch().finally(() => setBusy(false))
          resolve(false)
        })`, `        .catch((error) => {
          runStartingRef.current = false;
          queueRunResolverRef.current = null;
          void finishHistoryBatch().finally(() => setBusy(false));
          wbExecutionQueueErrorRef.current = error;
          resolve(false);
        })`);
    replace("      if (!ok) break // stopped or failed: the remaining pages stay queued for a retry", `      // One native receipt covers the captured whole queue. The visible observer
      // must never submit the remaining pages again after the child finished them.
      if (loop.remoteExecution) {
        if (ok) onQueueConsume?.(groups.flatMap(g => g.entries.map(e => e.item.key)));
        break;
      }
      if (!ok || officeExecutionSignal()?.aborted) break // untouched pages stay queued`);
    replace(`          void finishHistoryBatch().finally(() => {
            setBusy(false)
            // Post-generation layout QC: only after a completed run that landed generated pages
            if (cancelled) qcPagesRef.current = []
            else if (qcPagesRef.current.length > 0) void runQcPassRef.current()
            // After the batch closes, so the next queued page opens a fresh one
            const resolveQueueRun = queueRunResolverRef.current
            queueRunResolverRef.current = null
            resolveQueueRun?.(!cancelled)
          })`, `          void (async () => {
            try {
              await finishHistoryBatch();
              setBusy(false);
              if (cancelled || officeExecutionSignal()?.aborted) qcPagesRef.current = [];
              else if (qcPagesRef.current.length > 0) await optionalOfficeExecution(() => runQcPassRef.current());
              const resolveQueueRun = queueRunResolverRef.current;
              queueRunResolverRef.current = null;
              resolveQueueRun?.(!cancelled && !officeExecutionSignal()?.aborted);
              wbExecutionCompleteRef.current?.resolve();
            } catch (error) {
              queueRunResolverRef.current?.(false); queueRunResolverRef.current = null;
              wbExecutionCompleteRef.current?.reject(error);
            } finally { wbExecutionCompleteRef.current = null; }
          })()`);
    replace("            resolveQueueRun?.(false)\n          })", "            resolveQueueRun?.(false)\n            wbExecutionCompleteRef.current?.reject(new Error(error)); wbExecutionCompleteRef.current = null;\n          })");
    replace("pages.length === 0 || !access || qcRunningRef.current || !isQcEnabled()", "pages.length === 0 || !access || qcRunningRef.current || !(wbExecutionQcRef.current ?? isQcEnabled()) || officeExecutionSignal()?.aborted");
    replace("    qcAbortRef.current = controller", "    qcAbortRef.current = controller\n    const wbOwnerSignal = officeExecutionSignal();\n    const wbStopQc = () => controller.abort();\n    wbOwnerSignal?.addEventListener('abort', wbStopQc, { once: true });\n    if (wbOwnerSignal?.aborted) controller.abort();");
    replace("      qcRunningRef.current = false", "      wbOwnerSignal?.removeEventListener('abort', wbStopQc);\n      qcRunningRef.current = false");
    const run = code.match(/        loop\.run\(modelInstruction, images[^\n]*\)/g);
    if (run?.length !== 1) throw new Error("Original PPTX send completion boundary changed");
    replace(run[0]!, `${run[0]}\n        wbExecutionStartRef.current?.resolve(true)\n        wbExecutionStartRef.current = null`);
    replace(`      .catch(() => {
        runStartingRef.current = false
        void finishHistoryBatch().finally(() => setBusy(false))
      })`, `      .catch((error) => {
        wbExecutionStartRef.current?.reject(error)
        wbExecutionCompleteRef.current?.reject(error); wbExecutionCompleteRef.current = null;
        wbExecutionStartRef.current = null
        runStartingRef.current = false
        void finishHistoryBatch().finally(() => setBusy(false))
      })`);
    replace("  useEffect(() => () => qcAbortRef.current?.abort(), [])", `  useEffect(() => () => {
    wbExecutionStartRef.current?.reject(new Error('슬라이드 실행 준비 중 편집기가 닫혔습니다.'));
    wbExecutionStartRef.current = null;
    wbExecutionCompleteRef.current?.reject(new Error('슬라이드 실행이 닫혔습니다.'));
    wbExecutionCompleteRef.current = null;
    loopRef.current?.detach();
    qcAbortRef.current?.abort();
  }, [])`);
    const marker = "  const cancel = () => {";
    replace(marker, `  useEffect(() => registerOriginalExecutor({
    ready: () => Boolean(loopRef.current && slidesRef.current[currentRef.current] && wbRestoreSelectionRef.current),
    capture: () => ({ format: 'pptx', data: {
      selection: wbCapturePresentationSelection(slidesRef.current, currentRef.current, selectedRef.current),
      scope: lastScopeRef.current ?? null, attachments: lastAttachmentsRef.current,
      sentAttachments: sentAttachmentsRef.current, template: templateSelectionState.current(),
      queueRun: Boolean(queueRunResolverRef.current),
      queue: queueRunResolverRef.current ? wbSubmittedQueueRef.current : null,
      settings: settingsRef.current, qcEnabled: isQcEnabled(),
      instruction: lastInstructionRef.current,
      queueText: queueRunResolverRef.current ? wbQueueTextRef.current : null,
    } }),
    execute: async (instruction, state) => {
      if (state.format !== 'pptx') throw new Error('PPTX 실행 상태가 아닙니다.');
      const data = state.data as {
        selection: Parameters<typeof wbRestorePresentationSelection>[1]; scope: AiScopeQuoteData | null;
        attachments: AttachmentMeta[]; sentAttachments: AttachmentMeta[];
        template: ReturnType<typeof templateSelectionState.current>; queueRun: boolean;
        queue: EditQueueItem[] | null; settings: AiSettings; qcEnabled: boolean; instruction: string;
      };
      if (data.queueRun && (!Array.isArray(data.queue) || data.queue.length === 0)) throw new Error('원본 슬라이드 대기열을 전달하지 못했습니다.');
      const loop = loopRef.current;
      if (!loop || loop.busy || runStartingRef.current || qcRunningRef.current) return false;
      const selection = wbRestorePresentationSelection(slidesRef.current, data.selection);
      wbRestoreSelectionRef.current(selection.current, selection.ids);
      sentAttachmentsRef.current = data.sentAttachments;
      await templateSelectionState.refresh();
      templateSelectionState.restoreExecutionSelection(data.template);
      wbExecutionSettingsRef.current = structuredClone(data.settings);
      settingsRef.current = wbExecutionSettingsRef.current;
      wbExecutionQcRef.current = data.qcEnabled;
      wbExecutionQueueRef.current = data.queueRun ? data.queue : null;
      return withOfficeExecution(async signal => {
        const stop = () => { loopRef.current?.cancel(); qcAbortRef.current?.abort(); };
        signal.addEventListener('abort', stop, { once: true });
        try {
          if (data.queueRun) {
            wbExecutionQueueErrorRef.current = null;
            await sendEditQueue();
            if (wbExecutionQueueErrorRef.current) throw wbExecutionQueueErrorRef.current;
          }
          else await new Promise<void>((resolve, reject) => {
            wbExecutionCompleteRef.current = { resolve, reject };
            runWith(data.instruction || instruction, undefined, { attachments: data.attachments, scope: data.scope ?? undefined });
            if (!runStartingRef.current && !loop.busy) { wbExecutionCompleteRef.current = null; reject(new Error('원본 슬라이드 요청을 시작하지 못했습니다.')); }
          });
        } finally { signal.removeEventListener('abort', stop); }
      });
    },
    lock: wbLockPresentationSurface,
  }), []);

${marker}`);
    return `${imports}${code}`;
  }
  return code;
}
