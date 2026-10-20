/**
 * The animation module as other features use it (video and GIF export, audio, plugins): the document model, the sampler
 * and the frame renderer. Importing it also registers the built-in presets. Nothing here touches the editor's canvas,
 * history or autosave.
 */
import './builtins'

export { documentHasMotion, normalizeAnim, normalizeObjectAnimation, normalizeTransition, pageHasAnimation, pageHasMotion, pageSpans, pageTiming, transitionOf, type AnimSlot, type AnimSpan, type PageTiming } from './model'
export { sampleObject, sampleTransition, sampleUnit, type PageDims, type Sample } from './sampler'
export { createFrameRenderer, renderFrame, type FrameRenderer, type FrameRendererOptions } from './frameRenderer'
export { drawTransition } from './transitionRenderer'
export { emphasisPresets, inOutPresets, registerEmphasisPreset, registerInOutPreset, registerTransitionPreset, transitionPresets, type TransitionSample } from './presets'
export { registerTimelineSection, timelineSections, type TimelineSection, type TimelineSectionProps } from './sections'
