/** Pinned original renderers remain the document engines. These guarded
 * transforms bind their send/tool/readiness paths to the admitted executor. */
export function patchBookExecutions(code: string, id: string, root: string, module: string): string {
  const helper = module.replace(/execution-adapter\.ts$/, "execution-book-state.ts");
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2) throw new Error(`Original book executor boundary changed: ${id}: ${before.slice(0, 100)}`);
    code = code.replace(before, after);
  };
  const imports = (names: string, helpers: string) => {
    if (helper === module) throw new Error("Original book executor helper module could not be resolved");
    if (names) code = `import { ${names} } from ${JSON.stringify(module)};\n${code}`;
    if (helpers) code = `import { ${helpers} } from ${JSON.stringify(helper)};\n${code}`;
  };

  if (id === `${root}/apps/sheets/src/renderer/App.tsx`) {
    replace("      !sendGate.admit({\n        instruction: overrideInstruction,", "      !isOfficeExecutor() && !sendGate.admit({\n        instruction: overrideInstruction,");
    replace("    const agentConfigured = isAgentConfigured()", "    const agentConfigured = isOfficeExecutor() || isAgentConfigured()");
    replace("    setAiRunScope(aiScopeDismissed ? null : aiScope)", "    setAiRunScope(isOfficeExecutor() ? wbFrozenScopeRef.current ?? null : aiScopeDismissed ? null : aiScope)");
    replace("    const sentAtts = overrideAttachments ?? attachmentsRef.current", `    const sentAtts = overrideAttachments ?? attachmentsRef.current
    if (!isOfficeExecutor()) {
      const workbook = univerRef.current?.univerAPI.getActiveWorkbook();
      const sheetId = workbook?.getActiveSheet()?.getSheetId();
      if (!sheetId) throw new Error('원본 통합 문서의 시트가 준비되지 않았습니다.');
      const range = workbook?.getActiveRange()?.getRange();
      wbBookRequestRef.current = bookExecutionJson({ schema: 1,
        request: { text: instruction, skillUse, attachments: [...sentAtts] },
        availableAttachments: availableAttachments(),
        context: { sheetId, sheetName: workbook!.getActiveSheet()!.getSheetName(), scope: aiScopeDismissed ? null : aiScope,
          range: range ? { startRow: range.startRow, endRow: range.endRow, startColumn: range.startColumn, endColumn: range.endColumn } : null },
      });
    }`);
    replace("  function handleStopAgent(): void {", `  type WbSheetState = {
    schema: 1;
    request: { text: string; skillUse: SkillUse; attachments: AttachmentMeta[] };
    availableAttachments: AttachmentMeta[];
    context: { sheetId: string; sheetName: string; scope: FrozenSelection | null; range: { startRow: number; endRow: number; startColumn: number; endColumn: number } | null };
  };
  const wbBookRequestRef = useRef<WbSheetState | null>(null);
  const wbFrozenScopeRef = useRef<FrozenSelection | null>(null);
  const wbBookLockRef = useRef(createOriginalBookLock('.excel-header, .sheet-main, .formula-bar, #univer-container'));
  const wbBookLatestRef = useRef<Parameters<typeof registerOriginalExecutor>[0] | null>(null);
  wbBookLatestRef.current = {
    ready: () => !workbookOpeningRef.current && !openingWorkbook && Boolean(univerRef.current?.univerAPI.getActiveWorkbook()) && (!isOfficeExecutor() || Boolean(lazyWorkbookRef.current)),
    capture: () => {
      if (!wbBookRequestRef.current) throw new Error('원본 Sheets 요청이 준비되지 않았습니다.');
      return { format: 'xlsx', data: bookExecutionJson(wbBookRequestRef.current) };
    },
    execute: async (instruction, state) => {
      if (state.format !== 'xlsx' || aiBusy || runStartingRef.current || agentLoopRef.current?.busy) return false;
      const data = readBookExecution<WbSheetState>(state.data, instruction);
      const context = data.context;
      if (!context || typeof context.sheetId !== 'string' || !Array.isArray(data.request.attachments) || !Array.isArray(data.availableAttachments)) throw new Error('원본 Sheets 선택 상태가 올바르지 않습니다.');
      const workbook = univerRef.current?.univerAPI.getActiveWorkbook();
      // The original first save can assign IDs to a new workbook's sheets.
      const sheet = workbook?.getSheetBySheetId(context.sheetId) ?? workbook?.getSheets().find(item => item.getSheetName() === context.sheetName);
      if (!workbook || !sheet) throw new Error('저장한 통합 문서에서 선택한 시트를 찾을 수 없습니다.');
      if (context.range) {
        const r = context.range;
        if (![r.startRow, r.endRow, r.startColumn, r.endColumn].every(n => Number.isSafeInteger(n) && n >= 0) || r.endRow < r.startRow || r.endColumn < r.startColumn) throw new Error('저장한 셀 범위가 올바르지 않습니다.');
        const restored = await selectWorkbookRange(readContext(), sheet.getSheetId(), r, setMessage);
        if (!restored.ok) throw new Error(restored.error ?? '원본 셀 선택을 복원하지 못했습니다.');
      } else workbook.setActiveSheet(sheet);
      if (context.scope && (typeof context.scope.a1 !== 'string' || context.scope.sheetId !== context.sheetId)) throw new Error('원본 선택 범위의 시트가 일치하지 않습니다.');
      wbBookRequestRef.current = data;
      wbFrozenScopeRef.current = context.scope ? { ...context.scope, sheetId: sheet.getSheetId() } : null;
      sentAttachmentsRef.current = data.availableAttachments;
      let accepted = false;
      handleSend(data.request.text, data.request.attachments, undefined, data.request.skillUse, () => { accepted = true; });
      return accepted;
    },
    lock: wbBookLockRef.current,
  };
  useEffect(() => {
    const off = registerOriginalExecutor({
      ready: () => wbBookLatestRef.current!.ready(), capture: () => wbBookLatestRef.current!.capture(),
      execute: (instruction, state) => wbBookLatestRef.current!.execute(instruction, state), lock: wbBookLockRef.current,
    });
    return () => { off(); wbBookLockRef.current(false); agentLoopRef.current?.detach(); };
  }, []);

  function handleStopAgent(): void {`);
    imports("registerOriginalExecutor, isOfficeExecutor", "bookExecutionJson, readBookExecution, createOriginalBookLock");
  }

  if (id === `${root}/apps/pdf/src/renderer/ai/AiPanel.tsx`) {
    replace("    if (!sendGate.admit({ text: instruction, scope: retryScope, skillUse })) {", "    if (!isOfficeExecutor() && !sendGate.admit({ text: instruction, scope: retryScope, skillUse })) {");
    replace("  apiRef.current = api", `  type WbPdfState = {
    schema: 1; request: { text: string; skillUse: SkillUse; scope: AiScopeQuoteData | null };
    context: { page: number; selection: FollowUpSelection | null };
  };
  const wbBookRequestRef = useRef<WbPdfState | null>(null);
  const wbPdfContextRef = useRef<WbPdfState['context'] | null>(null);
  apiRef.current = isOfficeExecutor() && wbPdfContextRef.current ? {
    ...api,
    currentPage: () => wbPdfContextRef.current!.page,
    selection: () => wbPdfContextRef.current!.selection,
    gotoPage: (page) => {
      const moved = api.gotoPage(page);
      if (moved) wbPdfContextRef.current!.page = page;
      return moved;
    },
  } : api`);
    replace("      setFileOpConfirm(req)\n      signal?.addEventListener", `      setFileOpConfirm(req)
      if (isOfficeExecutor()) void askOfficeExecutionQuestion([req.summary, req.detail].filter(Boolean).join('\\n\\n'))
        .then(ok => pending.settle(ok), () => pending.settle(false));
      signal?.addEventListener`);
    replace("      } catch (err) {\n        patchLast({\n          streaming: false,", "      } catch (err) {\n        if (isOfficeExecutor()) reportOfficeExecutionError(err);\n        patchLast({\n          streaming: false,");
    replace("    persistMessage('user', instruction, undefined, scope, skillUse.chips)", `    if (!isOfficeExecutor()) {
      // A save flattens the pending page order. Capture its saved-file positions,
      // while keeping the original selected text and passage-card follow-up.
      const order = apiRef.current.pageOrder();
      const position = (page: number) => {
        const index = order.indexOf(page - 1);
        if (index < 0) throw new Error('저장할 PDF에 선택한 페이지가 없습니다.');
        return index + 1;
      };
      const selected = apiRef.current.selection() as FollowUpSelection | null;
      const selection = selected ? { ...selected, page: position(selected.page), lastPage: position(selected.lastPage) } : null;
      if (selection && selection.lastPage < selection.page) throw new Error('페이지 순서를 저장한 뒤 PDF 범위를 다시 선택해 주세요.');
      wbBookRequestRef.current = bookExecutionJson({ schema: 1, request: { text: instruction, skillUse, scope: scope ?? null }, context: { page: position(apiRef.current.currentPage()), selection } });
    }
    persistMessage('user', instruction, undefined, scope, skillUse.chips)`);
    replace("  const stop = (): void => {", `  const wbBookLockRef = useRef(createOriginalBookLock('.app-content, .ribbon'));
  const wbBookLatestRef = useRef<Parameters<typeof registerOriginalExecutor>[0] | null>(null);
  wbBookLatestRef.current = {
    ready: () => Boolean(apiRef.current.doc() && apiRef.current.pageCount() > 0),
    capture: () => {
      if (!wbBookRequestRef.current) throw new Error('원본 PDF 요청이 준비되지 않았습니다.');
      return { format: 'pdf', data: bookExecutionJson(wbBookRequestRef.current) };
    },
    execute: (instruction, state) => {
      if (state.format !== 'pdf' || !loopRef.current || loopRef.current.busy) return false;
      const data = readBookExecution<WbPdfState>(state.data, instruction);
      if (!data.context || !Number.isSafeInteger(data.context.page) || data.context.page < 1 || data.context.page > apiRef.current.pageCount()) throw new Error('저장한 PDF의 페이지 상태가 올바르지 않습니다.');
      const selected = data.context.selection;
      if (selected && (typeof selected.text !== 'string' || !Number.isSafeInteger(selected.page) || !Number.isSafeInteger(selected.lastPage) || selected.page < 1 || selected.lastPage < selected.page || selected.lastPage > apiRef.current.pageCount())) throw new Error('저장한 PDF 선택 범위를 복원할 수 없습니다.');
      if (!api.gotoPage(data.context.page)) throw new Error('원본 PDF 페이지로 이동하지 못했습니다.');
      wbBookRequestRef.current = data; wbPdfContextRef.current = data.context;
      apiRef.current = { ...api, currentPage: () => wbPdfContextRef.current!.page, selection: () => wbPdfContextRef.current!.selection,
        gotoPage: (page) => { const moved = api.gotoPage(page); if (moved) wbPdfContextRef.current!.page = page; return moved; } };
      send(data.request.text, data.request.scope, data.request.skillUse);
      return true;
    },
    lock: wbBookLockRef.current,
  };
  useEffect(() => {
    const off = registerOriginalExecutor({
      ready: () => wbBookLatestRef.current!.ready(), capture: () => wbBookLatestRef.current!.capture(),
      execute: (instruction, state) => wbBookLatestRef.current!.execute(instruction, state), lock: wbBookLockRef.current,
    });
    return () => { off(); wbBookLockRef.current(false); loopRef.current?.detach(); };
  }, []);

  const stop = (): void => {`);
    imports("registerOriginalExecutor, isOfficeExecutor, askOfficeExecutionQuestion, reportOfficeExecutionError", "bookExecutionJson, readBookExecution, createOriginalBookLock");
  }

  if (id === `${root}/apps/epub/src/renderer/App.tsx`) {
    replace("    (request) =>\n      translateRef.current?.requestOpen({ lang: request.lang, chapters: request.chapters }) ?? {\n        unavailable: true,\n      },", `    (request) => waitOriginalBookTranslation(() =>
      translateRef.current?.requestOpen({ lang: request.lang, chapters: request.chapters }) ?? { unavailable: true as const }, isOfficeExecutor()),`);
    replace("  const flash = useCallback((next: Notice | null) => {", `  bindOriginalEpub(ai.host, {
    ready: () => phaseRef.current.kind === 'open' && Boolean(shownRef.current && frameDocRef.current),
    capture: () => {
      const doc = frameDocRef.current, view = ai.host.view();
      if (!doc || !view) throw new Error('원본 EPUB 장이 준비되지 않았습니다.');
      return bookExecutionJson({ view, topBlockId: topBlockId(doc) ?? null, selection: captureBookSelection(doc) });
    },
    restore: async (context) => {
      const open = phaseRef.current;
      if (open.kind !== 'open' || !context?.view || !Number.isSafeInteger(context.view.spineIndex) || context.view.spineIndex < 0 || context.view.spineIndex >= open.book.spine.length || typeof context.view.selection !== 'string') throw new Error('저장한 EPUB 장 상태가 올바르지 않습니다.');
      await goToRef.current(context.view.spineIndex, context.topBlockId ? { kind: 'block', id: context.topBlockId } : { kind: 'start' });
      const until = performance.now() + 15_000;
      while (!frameDocRef.current || shownRef.current?.spineIndex !== context.view.spineIndex) {
        if (performance.now() >= until) throw new Error('원본 EPUB 장을 불러오는 시간이 초과됐습니다.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!restoreBookSelection(frameDocRef.current, context.selection) || (frameDocRef.current.getSelection()?.toString() ?? '') !== context.view.selection) throw new Error('저장한 EPUB의 원본 선택 범위가 달라졌습니다. 다시 선택해 주세요.');
    },
  });

  const flash = useCallback((next: Notice | null) => {`);
    imports("isOfficeExecutor", "bindOriginalEpub, captureBookSelection, restoreBookSelection, bookExecutionJson, waitOriginalBookTranslation");
  }

  if (id === `${root}/apps/epub/src/renderer/ai/AiPanel.tsx`) {
    replace("    if (!sendGate.admit({ text: instruction, attachments: attachmentsOverride, skillUse })) {", "    if (!isOfficeExecutor() && !sendGate.admit({ text: instruction, attachments: attachmentsOverride, skillUse })) {");
    replace("      mountedRef.current = false\n      loopRef.current?.cancel()", "      mountedRef.current = false\n      loopRef.current?.detach()");
    replace("      } catch (err) {\n        if (!mountedRef.current || seq !== sendSeqRef.current) return", "      } catch (err) {\n        if (!mountedRef.current || seq !== sendSeqRef.current) return\n        if (isOfficeExecutor()) reportOfficeExecutionError(err);");
    replace("  hostRef.current = host", `  type WbEpubState = {
    schema: 1; request: { text: string; skillUse: SkillUse; attachments: AttachmentMeta[] };
    availableAttachments: AttachmentMeta[]; context: EpubExecutionContext;
  };
  const wbBookRequestRef = useRef<WbEpubState | null>(null);
  const wbEpubViewRef = useRef<EpubExecutionContext['view'] | null>(null);
  const wbSourceHostRef = useRef(host); wbSourceHostRef.current = host;
  hostRef.current = isOfficeExecutor() && wbEpubViewRef.current ? { ...host, view: () => wbEpubViewRef.current } : host`);
    replace("    const sentAtts = attachmentsOverride ?? attachmentsRef.current", `    const sentAtts = attachmentsOverride ?? attachmentsRef.current
    if (!isOfficeExecutor()) {
      const binding = originalEpubBinding(wbSourceHostRef.current);
      if (!binding?.ready()) throw new Error('원본 EPUB 장이 준비되지 않았습니다.');
      wbBookRequestRef.current = bookExecutionJson({ schema: 1, request: { text: instruction, skillUse, attachments: [...sentAtts] }, availableAttachments: availableAttachments(), context: binding.capture() });
    }`);
    replace("  const stop = (): void => {", `  const wbBookLockRef = useRef(createOriginalBookLock('.epub-reader, .ribbon, .epub-sidebar'));
  const wbBookLatestRef = useRef<Parameters<typeof registerOriginalExecutor>[0] | null>(null);
  wbBookLatestRef.current = {
    ready: () => Boolean(hostRef.current.book() && originalEpubBinding(wbSourceHostRef.current)?.ready()),
    capture: () => {
      if (!wbBookRequestRef.current) throw new Error('원본 EPUB 요청이 준비되지 않았습니다.');
      return { format: 'epub', data: bookExecutionJson(wbBookRequestRef.current) };
    },
    execute: async (instruction, state) => {
      if (state.format !== 'epub' || !loopRef.current || loopRef.current.busy) return false;
      const data = readBookExecution<WbEpubState>(state.data, instruction);
      if (!Array.isArray(data.request.attachments) || !Array.isArray(data.availableAttachments)) throw new Error('원본 EPUB 첨부 상태가 올바르지 않습니다.');
      const binding = originalEpubBinding(wbSourceHostRef.current);
      if (!binding?.ready()) return false;
      await binding.restore(data.context);
      wbBookRequestRef.current = data; wbEpubViewRef.current = data.context.view;
      hostRef.current = { ...wbSourceHostRef.current, view: () => wbEpubViewRef.current };
      sentAttachmentsRef.current = data.availableAttachments;
      return send(data.request.text, data.request.attachments, data.request.skillUse);
    },
    lock: wbBookLockRef.current,
  };
  useEffect(() => {
    const off = registerOriginalExecutor({
      ready: () => wbBookLatestRef.current!.ready(), capture: () => wbBookLatestRef.current!.capture(),
      execute: (instruction, state) => wbBookLatestRef.current!.execute(instruction, state), lock: wbBookLockRef.current,
    });
    return () => { off(); wbBookLockRef.current(false); };
  }, []);

  const stop = (): void => {`);
    imports("registerOriginalExecutor, isOfficeExecutor, reportOfficeExecutionError", "bookExecutionJson, readBookExecution, createOriginalBookLock, originalEpubBinding, type EpubExecutionContext");
  }

  if (id === `${root}/apps/epub/src/renderer/ai/book-tools.ts`) {
    replace("    if ('unavailable' in answer) {", "    const completed = originalBookTranslationResult(answer);\n    if (completed) return completed;\n    if ('unavailable' in answer) {");
    imports("", "originalBookTranslationResult");
  }

  if (id === `${root}/apps/epub/src/renderer/translate/BookTranslation.tsx`) {
    replace("      setReport({ lang: run.lang, report: combineReports(reports), outputs, failures, partial })", "      setReport({ lang: run.lang, report: combineReports(reports), outputs, failures, partial })\n      recordOriginalBookOutputs(outputs, failures);");
    replace("      } finally {\n        await unlock()\n      }\n    }\n\n    /** \"Export what is translated so far\"", `      } finally {
        await unlock()
        finishOriginalBookTranslation({ state: last.state === 'complete' ? 'complete' : last.state === 'stopped' ? 'stopped' : 'failed', done: last.done, total: last.total, failedBlocks: last.failed, ...(last.error ? { error: last.error } : {}) });
      }
    }

    /** "Export what is translated so far"`);
    replace("          if (locked) await writeResults(run, false)\n        } finally {\n          await unlock()\n        }\n        return { ok: true }", `          if (locked) await writeResults(run, false)
          else recordOriginalBookOutputs([], [p.t('btUnavailable')]);
        } finally {
          await unlock()
          finishOriginalBookTranslation({ state: 'complete' });
        }
        return { ok: true }`);
    replace("            onClose={() => setDialog(null)}", "            onClose={() => { setDialog(null); finishOriginalBookTranslation({ state: 'cancelled' }); }}");
    imports("", "recordOriginalBookOutputs, finishOriginalBookTranslation");
  }

  if (id === `${root}/apps/epub/src/renderer/translate/BookTranslateDialog.tsx`) {
    code = patchEpubTranslationDialog(code, id);
    imports("isOfficeExecutor, askOfficeExecutionQuestion, askOfficeExecutionInteraction", "");
  }
  return code;
}

function patchEpubTranslationDialog(code: string, id: string): string {
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2) throw new Error(`Original EPUB dialog boundary changed: ${id}: ${before.slice(0, 100)}`);
    code = code.replace(before, after);
  };
  replace('  return (\n    <div className="bt-mask"', `  // Relay choices into the original dialog state. The original pickLocation,
  // canNext and next functions still own path refusals and readiness.
  const [wbChoiceStage, setWbChoiceStage] = useState<'idle' | 'asking' | 'paths' | 'picking' | 'check' | 'advancing' | 'closed'>('idle');
  const wbLocationRef = useRef<EpubTranslationOutputKind | null>(null);
  const wbChoiceLatest = useRef({ analysis, step }); wbChoiceLatest.current = { analysis, step };
  useEffect(() => {
    if (!isOfficeExecutor()) return;
    if (step !== 'choose') { if (wbChoiceStage !== 'idle') setWbChoiceStage('idle'); return; }
    if (wbChoiceStage === 'idle') {
      if (load.kind === 'loading') return;
      if (!analysis) {
        setWbChoiceStage('closed');
        const close = () => { if (aliveRef.current) propsRef.current.onClose(); };
        void askOfficeExecutionQuestion(t('btLoadFailed')).then(close, close);
        return;
      }
      setWbChoiceStage('asking');
      const current = analysis;
      const available = analysis.rows.filter(row => row.blocked === null);
      if (available.length === 0) {
        const close = () => { if (aliveRef.current) propsRef.current.onClose(); };
        void askOfficeExecutionQuestion(t('btChaptersRequired') + '\\n' + analysis.rows.map(row => row.title + ' (' + row.blocked + ')').join('\\n')).then(close, close);
        return;
      }
      void askOfficeExecutionInteraction({
        prompt: [t('btTitle'), t('btIntro'), ...analysis.rows.filter(row => row.blocked !== null).map(row => row.title + ' (' + row.blocked + ')')].join('\\n'),
        fields: [
          { id: 'language', prompt: t('btLanguage'), required: true, options: TRANSLATION_LANGUAGES.map(code => ({ id: code, label: languageName(code, lang) })) },
          { id: 'chapters', prompt: t('btChapters'), required: true, multiple: true, options: available.map(row => ({ id: String(row.index), label: row.title })) },
          { id: 'kinds', prompt: t('btResultRequired'), required: true, multiple: true, options: RESULT_KINDS.map(kind => ({ id: kind, label: t(KIND_KEY[kind]) })) },
        ],
      }).then(answer => {
        if (!aliveRef.current) return;
        if (wbChoiceLatest.current.analysis !== current || wbChoiceLatest.current.step !== 'choose') { setWbChoiceStage('idle'); return; }
        if (!answer) { setWbChoiceStage('closed'); propsRef.current.onClose(); return; }
        const language = answer.language;
        const chapters = Array.isArray(answer.chapters) ? answer.chapters : typeof answer.chapters === 'string' ? [answer.chapters] : [];
        const outputs = Array.isArray(answer.kinds) ? answer.kinds : typeof answer.kinds === 'string' ? [answer.kinds] : [];
        const selected = available.filter(row => chapters.includes(String(row.index)));
        const selectedKinds = RESULT_KINDS.filter(kind => outputs.includes(kind));
        if (typeof language !== 'string' || !isTranslationLanguage(language) || selected.length === 0 || selected.length !== new Set(chapters).size || selectedKinds.length === 0 || selectedKinds.length !== new Set(outputs).size) throw new Error('원본 EPUB 번역 선택이 올바르지 않습니다.');
        changeLanguage(language);
        setChosen(new Set(selected.map(row => row.index)));
        setKinds(new Set(selectedKinds));
        setLocations({});
        setWbChoiceStage('paths');
      }).catch(() => { if (aliveRef.current) { setWbChoiceStage('closed'); propsRef.current.onClose(); } });
      return;
    }
    if (wbChoiceStage === 'paths' && !picking) {
      const missing = chosenKinds.find(kind => locations[kind]?.state !== 'picked');
      if (!missing) { setWbChoiceStage('advancing'); return; }
      wbLocationRef.current = missing; setWbChoiceStage('picking');
      void pickLocation(missing).finally(() => { if (aliveRef.current) setWbChoiceStage('check'); });
      return;
    }
    if (wbChoiceStage === 'check') {
      const at = wbLocationRef.current ? locations[wbLocationRef.current] : undefined;
      if (at?.state === 'picked') { setWbChoiceStage('paths'); return; }
      setWbChoiceStage('asking');
      const reason = at?.state === 'refused' ? t(REFUSAL_KEY[at.reason]) : t('btLocationRequired');
      void askOfficeExecutionQuestion(reason + '\\n' + t('btBack')).then(retry => {
        if (!aliveRef.current) return;
        if (retry) setWbChoiceStage('paths');
        else { setWbChoiceStage('closed'); propsRef.current.onClose(); }
      }, () => { if (aliveRef.current) propsRef.current.onClose(); });
      return;
    }
    if (wbChoiceStage === 'advancing') {
      if (canNext) { next(); return; }
      setWbChoiceStage('asking');
      void askOfficeExecutionQuestion([chapterError, kindError, locationError, noUnits ? t('btNothing') : null].filter(Boolean).join('\\n') + '\\n' + t('btBack')).then(retry => {
        if (!aliveRef.current) return;
        if (retry) setWbChoiceStage('idle');
        else { setWbChoiceStage('closed'); propsRef.current.onClose(); }
      }, () => { if (aliveRef.current) propsRef.current.onClose(); });
    }
  }, [step, load, analysis, wbChoiceStage, picking, lang0, chosenKinds.join(','), locations, canNext]);

  return (
    <div className="bt-mask"`);
  replace('  return (\n    <>\n      <ul className="bt-summary"', `  const [wbConfirmRevision, setWbConfirmRevision] = useState(0);
  const wbConfirmAlive = useRef(true);
  useEffect(() => { wbConfirmAlive.current = true; return () => { wbConfirmAlive.current = false; }; }, []);
  const wbConfirmKey = JSON.stringify({ docHash, target, routeKey, state: route.state, estimate, targets, dirty, sameAsBook, askRestart, notice: sendGate.noticeDue, message, revision: wbConfirmRevision });
  const wbConfirmLatest = useRef({ key: wbConfirmKey, notice: sendGate.noticeDue });
  wbConfirmLatest.current = { key: wbConfirmKey, notice: sendGate.noticeDue };
  const wbConfirmPending = useRef<string | null>(null);
  const wbConfirmAnswered = useRef<string | null>(null);
  const wbWasStarting = useRef(false);
  useEffect(() => {
    if (wbWasStarting.current && !starting) { wbConfirmAnswered.current = null; setWbConfirmRevision(value => value + 1); }
    wbWasStarting.current = starting;
  }, [starting]);
  useEffect(() => {
    if (!isOfficeExecutor() || starting || !estimate || route.state === 'checking' || wbConfirmPending.current || wbConfirmAnswered.current === wbConfirmKey) return;
    const key = wbConfirmKey;
    wbConfirmPending.current = key;
    const current = () => wbConfirmAlive.current && wbConfirmLatest.current.key === key;
    const originalText = (selector: string) => Array.from(document.querySelectorAll(selector)).map(node => node.textContent?.trim()).filter(Boolean).join('\\n');
    const summary = originalText('.bt-dialog .bt-summary, .bt-dialog [data-rights], .bt-dialog [data-same-language], .bt-dialog [data-provider-change], .bt-dialog [data-unsaved], .bt-dialog [data-nothing], .bt-dialog [data-error="start"]');
    void (async () => {
      if (sending && sendGate.noticeDue) {
        const notice = originalText('.bt-dialog [data-notice="book"], .bt-dialog .ai-sub-first');
        if (!notice) throw new Error('원본 번역 연결 안내가 준비되지 않았습니다.');
        const accept = await askOfficeExecutionQuestion([message, notice].filter(Boolean).join('\\n'));
        if (!current()) return;
        if (!accept) { onCancel(); return; }
        sendGate.acknowledgeNotice();
        const until = performance.now() + 10_000;
        while (wbConfirmAlive.current && wbConfirmLatest.current.notice && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
        if (wbConfirmAlive.current && wbConfirmLatest.current.notice) setMessage(t('btRouteChanged'));
        return;
      }
      if (askRestart) {
        const accept = await askOfficeExecutionQuestion(summary + '\\n' + t('btRestartConfirm', { language, count: estimate.done }));
        if (!current()) return;
        if (accept && canSend) { wbConfirmAnswered.current = key; startJob('restart'); }
        else setAskRestart(false);
        return;
      }
      const actions = [
        ...(canStart ? [{ id: 'translate', label: dirty ? t('btSaveAndStart') : t('btStart') }] : []),
        ...(nothingToSend && estimate.done > 0 ? [{ id: 'export', label: dirty ? t('btSaveAndExport') : t('btExport') }] : []),
        ...(canSend && estimate.done > 0 ? [{ id: 'restart', label: t('btRestart') }] : []),
        ...(!canStart && !nothingToSend ? [{ id: 'recheck', label: t('btConfirmChecking') }] : []),
        { id: 'back', label: t('btBack') }, { id: 'cancel', label: t('btCancel') },
      ];
      const connectionText = route.state !== 'ready' ? originalText('.bt-dialog .ai-connect-prompt, .bt-dialog .ai-sub-connect') || '원본 번역 연결을 확인해 주세요.' : '';
      const answer = await askOfficeExecutionInteraction({ prompt: [t('btConfirmTitle'), summary, connectionText, ...targets.map(result => t(KIND_KEY[result.kind]) + ': ' + result.path)].filter(Boolean).join('\\n'), fields: [{ id: 'action', prompt: t('btConfirmTitle'), options: actions, required: true }] });
      if (!current()) return;
      const action = answer?.action;
      if (!answer || action === 'cancel') { onCancel(); return; }
      if (!actions.some(option => option.id === action)) throw new Error('원본 번역 확인 응답이 올바르지 않습니다.');
      if (action === 'back') onBack();
      else if (action === 'restart') setAskRestart(true);
      else if (action === 'recheck') { connection.recheck(); setWbConfirmRevision(value => value + 1); }
      else if (action === 'export') { wbConfirmAnswered.current = key; exportStored(); }
      else if (action === 'translate') { wbConfirmAnswered.current = key; startJob('translate'); }
    })().catch(error => {
      if (wbConfirmAlive.current) { setMessage(error instanceof Error ? error.message : String(error)); onCancel(); }
    }).finally(() => {
      if (wbConfirmPending.current === key) wbConfirmPending.current = null;
      if (wbConfirmAlive.current && (wbConfirmLatest.current.key !== key || wbConfirmAnswered.current !== key)) setWbConfirmRevision(value => value + 1);
    });
  }, [wbConfirmKey, starting]);

  return (
    <>
      <ul className="bt-summary"`);
  return code;
}
