/** Guarded adapters for the pinned original. Keep a request's skill versions and
 * visible text with its queue entry, instead of inferring chips from model text. */
export function patchOfficeSkillConversation(code: string, id: string, root: string): string {
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2) throw new Error(`Original Office skill boundary changed: ${id}: ${before.slice(0, 90)}`);
    code = code.replace(before, after);
  };
  if (id === `${root}/apps/sheets/src/preload/index.ts`) {
    // A template exports a new copy even when the workbook has no edits.
    // Use the original copy validation only for this non-mutating byte channel;
    // the ordinary save and Save As handlers remain untouched.
    replace("  async workbookTemplateBytes(request) {\n    const validatedRequest = parseSaveRequest(request)", "  async workbookTemplateBytes(request) {\n    const validatedRequest = parseSaveRequest({ ...request, mode: 'save-as' })");
  }
  if (id === `${root}/packages/ui/src/SkillProposalCard.tsx`) {
    replace("  initialDraft,\n  onSaved,", "  initialDraft,\n  workbenchPreviewId,\n  onSaved,");
    replace("  const ids = useId()", "  const ids = useId()\n  const wbCardRef = useRef(crypto.randomUUID())\n  const wbCard = { id: wbCardRef.current, label: proposal.name || proposal.title, ...(proposal.target ? { targetId: proposal.target.id } : {}), ...(workbenchPreviewId ? { previewId: workbenchPreviewId } : {}) }");
    replace("  const templateContext: SkillCardTemplateContext = {\n    lang,", "  const templateContext: SkillCardTemplateContext = {\n    workbenchCard: wbCard,\n    lang,");
    replace(".checkName(name, forId)", ".checkName(name, forId, wbCard)");
    replace("bridge.saveFromCard(input).catch(() => null)", "bridge.saveFromCard({ ...input, card: wbCard }).catch((error) => { setWbSaveError(error instanceof Error ? error.message : String(error)); return null })");
    replace("  const [busy, setBusy] = useState(false)", "  const [busy, setBusy] = useState(false)\n  const [wbSaveError, setWbSaveError] = useState<string | null>(null)");
    replace("    setBusy(true)\n    setFailure(null)", "    setBusy(true)\n    setFailure(null)\n    setWbSaveError(null)");
    replace("{failure ? t(failure) : blocked}", "{wbSaveError || (failure ? t(failure) : blocked)}");
  }
  if (id === `${root}/packages/ui/src/SkillTemplateActions.tsx`) {
    replace("        proposal: context.proposal,", "        card: context.workbenchCard,\n        proposal: context.proposal,");
  }
  if (id === `${root}/packages/ui/src/use-skill-proposals.tsx`) {
    replace("          proposal={proposal}", "          proposal={proposal}\n          workbenchPreviewId={card.preview?.previewId}");
    replace("      return read.messages", `      // The original transcript closes unsaved cards. Recover links to durable previews.
      void globalThis.aiOfficeUserSkills?.previewLinks?.().then((links) => {
        setCards((prev) => {
          const next = new Map(prev), matched = new Set();
          for (const link of [...links].reverse()) {
            const original = [...read.proposals].reverse().find((p) => !matched.has(p.key) && p.title === link.label);
            if (!original) continue;
            matched.add(original.key);
            const card = next.get(original.key);
            if (!card) continue;
            next.set(original.key, { ...card, title: link.title || card.title, status: link.outcome === 'open' ? 'preview' : link.outcome,
              ...(link.outcome === 'open' ? { continuesIn: { tabId: link.tabId, previewId: link.previewId } } : {}) });
          }
          return next;
        });
      }).catch(() => undefined);
      return read.messages`);
  }
  if (id === `${root}/packages/ui/src/skill-send.ts`) {
    replace("  id: string\n  title: string", "  id: string\n  sha256?: string\n  title: string");
    replace("    id: s.id,\n    title:", "    id: s.id,\n    sha256: typeof s.sha256 === 'string' ? s.sha256 : undefined,\n    title:");
  }
  if (id === `${root}/packages/ui/src/use-composer-skills.tsx`) {
    replace("  chips: SkillChipRef[]\n}", "  chips: SkillChipRef[]\n  reads?: { id: string; sha256?: string }[]\n}");
    replace("send({ text: built.text, chips: composerChips.map(skillChipRef) })", "send({ text: built.text, chips: composerChips.map(skillChipRef), reads: skills.map(({ id, sha256 }) => ({ id, sha256 })) })");
  }
  if (id === `${root}/packages/ui/src/use-skill-templates.tsx`) {
    replace("options.bridge !== undefined ? options.bridge : skillTemplateBridge()", "options.bridge !== undefined ? options.bridge : (globalThis.workbenchOfficeAi?.templates ?? skillTemplateBridge())");
    // Reopening restores the card; it must never repeat the clearing model run.
    replace("      setHanded(taken)\n      let use:", "      setHanded(taken)\n      if (taken.resumed) { setRunPhase('done'); return }\n      let use:");
    replace("use = { text: built.text, chips: taken.chips.map(chipRefOf) }", "use = { text: built.text, chips: taken.chips.map(chipRefOf), reads: skills.map(({ id, sha256 }) => ({ id, sha256 })) }");
  }
  if (id === `${root}/packages/ui/src/skill-template-model.ts`) {
    replace("'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html' | 'mindmap' | 'hwp'", "'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html' | 'mindmap' | 'hwp' | 'epub'");
    replace("  'mindmap',\n  'hwp',\n])", "  'mindmap',\n  'hwp',\n  'epub',\n])");
    replace("return { id: raw.id, text: raw.text, chips, ...(preview ? { preview } : {}) }", "return { id: raw.id, text: raw.text, chips, resumed: raw.resumed === true, ...(preview ? { preview } : {}) }");
  }
  const context = (text: string) => `{ text: ${text}, chips: skillUse.chips, reads: skillUse.reads }`;
  for (const app of ["docs", "slides", "hwp", "html", "mindmap", "epub", "markdown", "pdf"]) {
    if (id !== `${root}/apps/${app}/src/renderer/ai/AiPanel.tsx`) continue;
    if (["html", "mindmap", "epub", "markdown"].includes(app)) {
      // The original checks `applied` immediately after a deferred state updater.
      // Confirm that history won before restoring its skill/attachment context.
      const historyStart = `        setChat((prev) => {\n${["mindmap", "epub"].includes(app) ? "          // a message sent while the history was loading wins over the history\n" : ""}          if (prev.length > 0) return prev\n          applied = true`;
      replace(historyStart, historyStart.replace("setChat(", "wbFlushSync(() => setChat("));
      if (app === "markdown") replace("        })\n        if (applied && !loopRef.current?.busy)", "        }))\n        if (applied && !loopRef.current?.busy)");
      else replace("        })\n        // the next request re-reads the current text", "        }))\n        // the next request re-reads the current text");
      code = `import { flushSync as wbFlushSync } from 'react-dom';\n${code}`;
    }
    if (app === "epub") {
      // EPUB already exposes the common skills and supports native handoff, but
      // its original panel omitted the shared template request hook.
      replace("  useComposerSkills,", "  useComposerSkills,\n  useSkillTemplates,");
      replace("  const skillCards = useSkillProposals({\n    lang,", "  const skillCards = useSkillProposals({\n    lang,\n    templateDocument: globalThis.workbenchEpubTemplateDocument?.() ?? null,");
      replace("const skills = useComposerSkills({ lang })", "const skills = useComposerSkills({ lang, onTemplateSkill: (request) => skillTemplatesRef.current.onTemplateSkill(request) })");
      replace("  skillCardsRef.current = skillCards\n", "  skillCardsRef.current = skillCards\n  const skillTemplates = useSkillTemplates({ lang, editor: 'epub', cards: skillCards, busy, send: (text, use) => send(text, undefined, use), setComposer: setPrompt });\n  const skillTemplatesRef = useRef(skillTemplates);\n  skillTemplatesRef.current = skillTemplates;\n");
      replace("          onProposal: (proposal) => {", "          onUsed: (skill) => skillTemplatesRef.current.onUsed(skill),\n          onProposal: (proposal) => {");
      replace("    lastSkillUseRef.current = skillUse\n    setBusy(true)", "    lastSkillUseRef.current = skillUse\n    skillTemplatesRef.current.noteRequest(text)\n    setBusy(true)");
      replace("        })}\n      </div>\n", "        })}\n        {skillTemplates.notes}\n      </div>\n");
    }
    if (app === "docs") replace("loop.run(instruction + skillUse.text, images)", `loop.run(instruction + skillUse.text, images, ${context("displayInstruction")})`);
    else if (app === "slides") replace("loop.run(modelInstruction, images)", `loop.run(modelInstruction, images, ${context("shown")})`);
    else if (app === "hwp") replace("          images.length > 0 ? images : undefined,\n        )", `          images.length > 0 ? images : undefined,\n          ${context("text")},\n        )`);
    else if (app === "markdown" || app === "pdf") replace("loop.run(instruction + skillUse.text)", `loop.run(instruction + skillUse.text, undefined, ${context(app === "markdown" ? "displayText ?? instruction" : "instruction")})`);
    else replace("loop.run(instruction + skillUse.text, images.length > 0 ? images : undefined)", `loop.run(instruction + skillUse.text, images.length > 0 ? images : undefined, ${context("instruction")})`);
  }
  if (id === `${root}/apps/sheets/src/renderer/App.tsx`) {
    replace("function runAgent(instruction: string, sentAttachments: readonly AttachmentMeta[]): void {", "function runAgent(instruction: string, sentAttachments: readonly AttachmentMeta[], skillContext?: Parameters<WorkbenchAgentLoop['run']>[2]): void {");
    replace("loop.run(instruction, images)", "loop.run(instruction, images, skillContext)");
    replace("loop.run(instruction)\n      })", "loop.run(instruction, undefined, skillContext)\n      })");
    replace("runAgent(instruction + skillUse.text, sentAtts)", `runAgent(instruction + skillUse.text, sentAtts, ${context("instruction")})`);
  }
  return code;
}
