/**
 * Public extension API of the editor. Wave-2 features import from here and register at module load,
 * without editing core files:
 *
 * ```ts
 * import { registerPanel, registerToolbarSection, registerCommand, registerExportFormat, registerObjectKind, useEditor } from '@/editor/extensions'
 * ```
 *
 *
 */
export { registerCommand, type Command, type CommandContext } from './commands'
export { registerPanel, type PanelDefinition } from './panels/registry'
export { registerToolbarSection, type ToolbarSectionDefinition } from './toolbar/registry'
export { registerDialog, type DialogDefinition } from './dialogs/registry'
export { registerPalette, type Palette } from './ui/swatches'
export { registerObjectKind, type ObjectKind, type KindLoadContext } from './engine/objects/kinds'
export {
  registerEmphasisPreset,
  registerInOutPreset,
  registerTransitionPreset,
  type Effect,
  type EffectContext,
  type EmphasisPreset,
  type InOutPreset,
  type TransitionPreset,
} from './animation/presets'
export { registerTimelineSection, type TimelineSection, type TimelineSectionProps } from './animation/sections'
export { playbackOf, usePlayback, usePlaybackValue, type PlaybackState } from './animation/playback'
export { mixAudio, type MixOptions } from './audio/mixer'
export { canEncode, encodeAudio, wavBlob, type AudioFormat, type EncodedAudio, type EncodedChunk, type EncodeOptions } from './audio/encoder'
export { pageDurationsMs } from './audio/clock'
export { TimelineRow } from './workspace/TimelineRow'
export { registerExportFormat, type ExportFormat, type ExportContext, type ExportFile, type ExportOptions } from './engine/export/registry'
export { useEditor, useEditorState, useEditorStateShallow, useSelection, useDocument } from './context'
export type { EditorEngine } from './engine/editor'
export { getPageSize, type PageSize } from './engine/pageSizes'
export type { PageRect } from './engine/api/view'
export type { EditorState, SelectionState } from './store/editorStore'
export { EXTRA_PROPS, serializeObject } from './engine/serialization'
export { Button, IconButton } from './ui/Button'
export { Popover, PopoverButton } from './ui/Popover'
export { Slider } from './ui/Slider'
export { NumberField } from './ui/NumberField'
export { Segmented } from './ui/Segmented'
export { Switch } from './ui/Switch'
export { Dialog } from './ui/Dialog'
export { Skeleton } from './ui/Skeleton'
export { ColorPicker } from './ui/ColorPicker'
export { FillEditor } from './ui/FillEditor'
export { t as strings } from './strings'
export { isBold, textValue } from './builtins/textState'
