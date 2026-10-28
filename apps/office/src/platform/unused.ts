// Parts of IeumOffice's slides editor main code that Workbench does not run: the editor's own AI
// (Workbench keeps AI in its conversation), skill templates and AI page generation, presenter
// windows, PDF export and printing through hidden windows, project lists, the standalone app's
// network proxy. Each name the editor code imports is here, doing nothing, so the rest of that
// code loads unchanged inside the editor page's worker.

const noop = () => {};
const nothing = async () => null;
const notHere = async () => {
  throw new Error("Workbench에서는 쓰지 않는 기능입니다.");
};

// AI (./ai-ipc, ./attachments-ipc, ./generate-handoff-ipc, @genoffice/ai-provider/subscription)
export const registerAiIpc = noop;
export const registerSlidesOnlyAiIpc = noop;
export const registerAttachmentIpc = noop;
export const registerGenerateHandoffIpc = noop;
export const shutdownSubscriptionChildren = noop;

// AI-generated pages and skill templates (@genoffice/pipelines/slides, ./template-*, ./seed-*)
export const buildPagePptx = notHere;
export const parsePageSpec = () => {
  throw new Error("Workbench에서는 쓰지 않는 기능입니다.");
};
export const cleanupExpiredGeneratedPages = nothing;
export const registerSlidesTemplateBytesIpc = noop;
export const registerTemplateCoverIpc = noop;
export const initTemplateFonts = noop;
export const registerTemplateFontsIpc = noop;
export const followTemplateSelection = noop;
export const inheritTemplateSelection = noop;
export const openSlidesSeed = nothing;
export const queueSlidesSeedFor = noop;

// Other windows (./presenter-show, ./pdf-export, ./print-window)
export const registerPresenterIpc = noop;
export const exportSlidesPdf = notHere;
export const printSlidesHtml = notHere;

// Projects (@genoffice/project-store)
export class ProjectStore {
  list() {
    return [];
  }
  get() {
    return null;
  }
}

// The standalone app's proxy setup (undici)
export class ProxyAgent {}
export const setGlobalDispatcher = noop;

// TIFF pictures are shown as missing for now (./tiff-decode)
export const tiffToPng = () => null;

// Complex-script shaping through a hidden renderer (./shaped-metrics)
export const shapedMetricsReady = async () => undefined;
export const refineComplexWidths = async () => false;

// Installing font files (./font-store) and the font picker's extra names (@genoffice/font-metrics)
export const initFontStore = noop;
export const installLocalFontFiles = async () => ({ installed: [], failed: [] });
export const familyInfoFor = async () => [];

export default {};
