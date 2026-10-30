/** Guarded adapters for the pinned original. Keep a request's skill versions and
 * visible text with its queue entry, instead of inferring chips from model text. */
export function patchOfficeSkillConversation(code: string, id: string, root: string): string {
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2) throw new Error(`Original Office skill boundary changed: ${id}: ${before.slice(0, 90)}`);
    code = code.replace(before, after);
  };
  if (id === `${root}/packages/ui/src/skill-send.ts`) {
    replace("  id: string\n  title: string", "  id: string\n  sha256?: string\n  title: string");
    replace("    id: s.id,\n    title:", "    id: s.id,\n    sha256: typeof s.sha256 === 'string' ? s.sha256 : undefined,\n    title:");
  }
  if (id === `${root}/packages/ui/src/use-composer-skills.tsx`) {
    replace("  chips: SkillChipRef[]\n}", "  chips: SkillChipRef[]\n  reads?: { id: string; sha256?: string }[]\n}");
    replace("send({ text: built.text, chips: composerChips.map(skillChipRef) })", "send({ text: built.text, chips: composerChips.map(skillChipRef), reads: skills.map(({ id, sha256 }) => ({ id, sha256 })) })");
  }
  if (id === `${root}/packages/ui/src/use-skill-templates.tsx`) {
    // Template creation/handoff does not need the proposal-card preview bridge.
    // Keep the latter unavailable until its own persistence boundary is connected.
    replace("options.bridge !== undefined ? options.bridge : skillTemplateBridge()", "options.bridge !== undefined ? options.bridge : (globalThis.workbenchOfficeAi?.templates ?? skillTemplateBridge())");
    replace("use = { text: built.text, chips: taken.chips.map(chipRefOf) }", "use = { text: built.text, chips: taken.chips.map(chipRefOf), reads: skills.map(({ id, sha256 }) => ({ id, sha256 })) }");
  }
  if (id === `${root}/packages/ui/src/skill-template-model.ts`) {
    replace("'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html' | 'mindmap' | 'hwp'", "'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html' | 'mindmap' | 'hwp' | 'epub'");
    replace("  'mindmap',\n  'hwp',\n])", "  'mindmap',\n  'hwp',\n  'epub',\n])");
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
