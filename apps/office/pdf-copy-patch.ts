/** Keep the original Save As UI and redaction confirmation. Only the shell
 * entrypoint and post-redaction tab handoff differ from Electron. */
export function patchPdfCopy(code: string): string {
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2) throw new Error(`Original PDF copy boundary changed: ${before.slice(0, 90)}`);
    code = code.replace(before, after);
  };
  replace("    if (applyingRedactions) {\n      // The main process has committed", "    // Workbench opens the sanitized artifact in a fresh iframe. Never reload\n    // its target path through the original artifact's read/recovery/history grant.\n    if (applyingRedactions && 'workbenchCopy' in result && result.workbenchCopy) return true\n    if (applyingRedactions) {\n      // The main process has committed");
  replace("                      checked={saveCopyMode === 'keep'}", "                      autoFocus\n                      checked={saveCopyMode === 'keep'}");
  // Workbench keeps immutable artifact revisions. Each redaction therefore
  // opens a fresh copy, so its own history cannot reveal the removed content.
  replace("if (!window.confirm(t('redactConfirm'))) return", "if (!window.confirm('표시한 영역의 내용이 영구적으로 제거됩니다. 가림 처리한 새 PDF 사본을 만들어 엽니다. 계속하시겠습니까?')) return");
  const marker = `          <button
            className="qa-btn"
            data-tip={\`\${t('undo')} (\${platformShortcuts('⌘Z')})\`}`;
  replace(marker, `          <button
            className="qa-btn"
            data-tip={\`\${t('saveCopyTitle')} (\${platformShortcuts('⇧⌘S')})\`}
            aria-label={t('saveCopyTitle')}
            disabled={status !== 'ready' || saveState === 'saving'}
            onClick={() => window.dispatchEvent(new CustomEvent('workbench:pdf-save-as'))}
          >
            <IconSave />
          </button>
` + marker);
  return code;
}
