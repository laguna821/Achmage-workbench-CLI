/** Original toolbar confirmation -> original job engine in the admitted renderer.
 * No reading/translation algorithm, store, resumability or model route is replaced. */
export function patchPdfJobExecutions(code: string, id: string, root: string, module: string) {
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2) throw new Error(`Original PDF job boundary changed: ${id}: ${before.slice(0, 100)}`);
    code = code.replace(before, after);
  };
  const reading = id === `${root}/apps/pdf/src/renderer/ai-read/AiPageReading.tsx`;
  const translation = id === `${root}/apps/pdf/src/renderer/translate/DocumentTranslation.tsx`;
  if (id === `${root}/apps/pdf/src/renderer/doc-jobs/job-session.ts`) {
    replace("onEnd?(view: DocumentJobView): void", "onEnd?(view: DocumentJobView): void | Promise<void>");
    replace("const end = (patch: Partial<DocumentJobView>) => {", "const end = async (patch: Partial<DocumentJobView>) => {");
    replace("      if (last) spec.onEnd?.(last)", `      if (last) {
        try { await spec.onEnd?.(last); await window.workbenchPdfJobs.finish(last); }
        catch (error) { await window.workbenchPdfJobs.finish({ ...last, state: 'failed', error: error instanceof Error ? error.message : String(error) }); }
      }`);
    return code;
  }
  if (!reading && !translation) return code;
  const kind = reading ? "ai-read" : "translate", request = reading ? "AiReadStartRequest" : "TranslateStartRequest", answer = reading ? "AiReadStartAnswer" : "TranslateStartAnswer";
  const signature = `    const start = async (request: ${request}): Promise<${answer}> => {`;
  replace(signature, `${signature}
      if (!isOfficeExecutor() && ${reading ? "true" : "request.mode !== 'export' && Boolean(request.route)"}) {
        try {
          if (await window.workbenchPdfJobs.handoff('${kind}', request)) { setDialog(null); return { ok: true }; }
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      }
      if (isOfficeExecutor()) {
        const current = await propsRef.current.api?.store.docHash(propsRef.current.filePath);
        if (!current?.ok || current.docHash !== request.docHash) return { ok: false, error: '확인한 PDF 판이 바뀌었습니다. 다시 확인한 뒤 요청해 주세요.' };
      }`);
  // The confirmed route is immutable. Availability still uses the original guard.
  replace("return jobRouteRefusal(route, current ?? null, statuses)", "return jobRouteRefusal(route, isOfficeExecutor() ? route.settings : current ?? null, statuses)");
  const marker = "    useImperativeHandle(ref, () => ({";
  replace(marker, `    useEffect(() => registerOriginalOfficeJob('${kind}', {
      ready: () => Boolean(propsRef.current.api && propsRef.current.filePath && docHashRef.current),
      execute: request => window.workbenchPdfJobs.execute('${kind}', request, () => start(request as unknown as ${request}), () => session.stopAll()),
    }), [session]);

${marker}`);
  if (reading) {
    replace("        onEnd: () => {\n          void renderer?.then((r) => r.close()).catch(() => {})", "        onEnd: async () => {\n          await renderer?.then((r) => r.close()).catch(() => {})");
    replace("if (now && now !== hash) void migrate(hash)", "if (now && now !== hash) await migrate(hash)");
  } else {
    replace("        onEnd: (view) => void ended(view, run),", "        onEnd: (view) => ended(view, run),");
    replace("      setReport({ lang: run.lang, report: combineReports(reports), outputs, failures })", "      setReport({ lang: run.lang, report: combineReports(reports), outputs, failures })\n      if (isOfficeExecutor() && failures.length) throw new Error('PDF 결과 저장 실패: ' + failures.join('\\n'));");
  }
  return `import { isOfficeExecutor, registerOriginalOfficeJob } from ${JSON.stringify(module)};\n${code}`;
}
