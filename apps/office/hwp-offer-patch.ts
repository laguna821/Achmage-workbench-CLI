/**
 * What the Hangul page's AI offers the model (v0.13.0, unit hwp13). Upstream's Hangul AI gained tools
 * that Workbench does not offer, by the owner's decisions:
 * - `import_attachment` (an attached Markdown file opened as a new Hangul tab): the dock has ONE tool
 *   for making a Hangul document, "한글 문서 만들기" (hallym-kordoc). The panel gives the engine no
 *   importer, so upstream's own rule leaves the tool and its prompt section out.
 * - `analyze_picture` (a provider looks at a picture of the document): the panel says no connection can
 *   look at pictures, so upstream's own rule leaves the tool out and tells the model so.
 * - `web_search`: left out of the tool list and its prompt section is not sent.
 * The window.hwpApi members behind them answer politely (apps/office/src/hwp.ts) should a model call
 * one anyway. Each replacement is found exactly once or the build stops.
 */
export function patchHangulOffer(code: string, id: string, root: string): string {
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2) throw new Error(`Original Hangul AI offer changed: ${id}: ${before.slice(0, 90)}`);
    code = code.replace(before, after);
  };
  if (id === `${root}/apps/hwp/src/renderer/ai/AiPanel.tsx`) {
    replace("      pictureAnalysisAvailable: () => imageAnalysisAvailableRef.current !== false,\n",
      "      // Workbench: no picture reading is offered to the Hangul AI (apps/office/hwp-offer-patch.ts)\n      pictureAnalysisAvailable: () => false,\n");
    replace(`      // a Markdown attachment as a new Hangul tab; the request of this run may go along
      importAttachment: async (name, handOver) => {
        const attachment = availableAttachmentsRef
          .current()
          .find((candidate) => candidate.name === name)
        if (!attachment) {
          return { ok: false, error: \`there is no file named "\${name}" attached to this chat.\` }
        }
        const request = handOver ? runRequestRef.current.trim() : ''
        return window.hwpApi.importAttachmentAsDocument(attachment.path, request || undefined)
      },
`, "      // Workbench: no importer (import_attachment is not offered; \"한글 문서 만들기\" makes Hangul documents)\n");
  }
  if (id === `${root}/apps/hwp/src/renderer/ai/hwp-skill.ts`) {
    replace(`  '## Web search',
  '- When you need up-to-date information, data, or facts beyond the document, use web_search; never fabricate numbers from memory.',
  '- When writing search results into the document, attribute the data source (a link or a source name).',
  '',
`, "");
    replace("        if (!pictureAnalysisOn())\n          offered = offered.filter((tool) => tool.name !== 'analyze_picture')\n        return offered\n",
      "        if (!pictureAnalysisOn())\n          offered = offered.filter((tool) => tool.name !== 'analyze_picture')\n        // Workbench: web_search is not offered (apps/office/hwp-offer-patch.ts)\n        offered = offered.filter((tool) => tool.name !== 'web_search')\n        return offered\n");
  }
  return code;
}

/** The tools the patch takes away, for checks. */
export const HANGUL_TOOLS_NOT_OFFERED = ["import_attachment", "analyze_picture", "web_search"] as const;
