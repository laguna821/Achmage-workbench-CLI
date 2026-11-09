/** Keep the original transport, including context budgets and cancellation.
 * Only the dialog wait becomes asynchronous for an independent renderer. */
export function patchExecutionTransport(code: string, id: string, root: string, module: string): string {
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2) throw new Error("Original executor context boundary changed: " + id);
    code = code.replace(before, after);
  };
  if (id === root + "/packages/agent-core/src/electron-transport.ts") {
    replace("confirmContext?(warning: ContextWarning): boolean", "confirmContext?(warning: ContextWarning): boolean | Promise<boolean>");
    const start = code.indexOf("      if (warning) {\n        let confirmed: boolean");
    const end = code.indexOf("      let settled = false", start);
    if (start < 0 || end < 0) throw new Error("Original executor context gate changed");
    const refusal = `const message = causeText({ kind: 'context-limit' }, undefined);
            try { options.onStreamError?.({ kind: 'context-limit', message }); } catch {}
            cb.onError(message);`;
    code = code.slice(0, start) + "      const startConfirmed = () => {\n" + code.slice(end);
    replace("      return { cancel: () => options.cancel(requestId) }\n    },", `      return { cancel: () => options.cancel(requestId) }
      };
      if (!warning) return startConfirmed();
      let cancelled = false, inner: { cancel(): void } | undefined;
      void Promise.resolve().then(() => cancelled ? false : options.confirmContext?.(warning)).then(confirmed => {
        if (cancelled) return;
        if (confirmed !== true) { cancelled = true; ${refusal} return; }
        if (request.runId) gate().markConfirmed(request.runId);
        inner = startConfirmed();
      }, () => { if (!cancelled) { cancelled = true; ${refusal} } });
      return { cancel: () => { if (cancelled) return; cancelled = true; if (inner) inner.cancel(); else cb.onDone(); } };
    },`);
    return code;
  }
  const targets = ["docs", "slides", "sheets", "hwp", "pdf", "markdown", "html", "mindmap", "epub"].map(app => root + "/apps/" + app + "/src/renderer/ai/transport.ts");
  targets.push(root + "/apps/epub/src/renderer/translate/model-call.ts");
  if (!targets.includes(id)) return code;
  const gate = /confirmContext: \(warning\) =>\s+window\.confirm\((aiContextConfirmText\([^\n]+\))\),/;
  if (!gate.test(code)) throw new Error("Original executor context callback changed: " + id);
  code = code.replace(gate, "confirmContext: (warning) => isOfficeExecutor() ? askOfficeExecutionQuestion($1) : window.confirm($1),");
  return `import { isOfficeExecutor, askOfficeExecutionQuestion } from ${JSON.stringify(module)};\n${code}`;
}
