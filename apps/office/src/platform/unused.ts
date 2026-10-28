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

// AI (./ai-ipc, ./ai-run, ./attachments-ipc, ./generate-handoff-ipc, @genoffice/ai-provider[/…],
// @genoffice/ai-search, @genoffice/file-parse, @genoffice/ui/ai-subscription-login-window)
export const registerAiIpc = noop;
export const registerSlidesOnlyAiIpc = noop;
export const registerAttachmentIpc = noop;
export const registerGenerateHandoffIpc = noop;
export const shutdownSubscriptionChildren = noop;
export const ensureSubscriptionIpc = noop;
export const sharedSubscriptionStatuses = async () => ({});
export const shutdownCodexAppServers = async () => undefined;
export const chatForProvider = notHere;
export const streamForProvider = notHere;
export const isAiOverloadedError = () => false;
export const maxOutputTokensOf = () => 0;
export const sealAiSecrets = <T>(settings: T) => settings;
export const setAiUserAgent = noop;
export const setRescueFetch = noop;
export const abortMediaCalls = noop;
export const aiToolCapabilities = async () => ({});
export const generateImageTool = notHere;
export const imageSearchTool = notHere;
export const readUrlTool = notHere;
export const webSearchTool = notHere;
export const localMediaRoots = () => [];
export const readAiSettingsFile = () => null;
export const withMediaCallSignal = <T>(_signal: unknown, run: () => T) => run();
export const aiRunBlockChunk = () => null;
export const aiSettingsFromStored = () => null;
export const aiStreamErrorChunk = () => null;
export const resolveAiRunTarget = () => null;
export const subscriptionStreamCallbacks = () => ({});
export const withMeteredAccepted = <T>(value: T) => value;
export const aiSubscriptionLoginWindowText = () => "";
export const ATTACHABLE_EXTS = new Set<string>();
export const ATTACHABLE_IMAGE_EXTS = new Set<string>();
export const ATTACHABLE_MAX_BYTES = 0;
export const ATTACHABLE_IMAGE_MAX_BYTES = 0;
export const parseFileToText = notHere;

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

// Other windows (./presenter-show, ./pdf-export, ./print-window), the standalone app's test server
// (node:http), its template-font protocol, legacy .xls conversion
export const registerPresenterIpc = noop;
export const exportSlidesPdf = notHere;
export const printSlidesHtml = notHere;
export const exportPdf = notHere;
export const printWorkbook = notHere;
export const installStandaloneTemplateFontProtocol = noop;
export const convertLegacyWorkbook = async () => {
  throw new Error("예전 엑셀 형식(.xls)은 Workbench에서 아직 열지 못합니다. .xlsx로 저장한 뒤 열어 주세요.");
};
export const createServer = () => ({ listen: noop, close: noop, on: noop });

// Projects (@genoffice/project-store)
export class ProjectStore {
  list() {
    return [];
  }
  get() {
    return null;
  }
  ensureDefaultProject() {
    return null;
  }
  rebindChat() {}
  rebindChatToFile() {}
  resolveChatForFile() {
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
