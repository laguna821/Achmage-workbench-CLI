/** Test support: reads the timeline flag of an editor without a component. */
import type { EditorEngine } from '../engine/editor'
import { timelineView } from './timelineVisibility'

export const isTimelineOpenForTest = (editor: EditorEngine): boolean => timelineView(editor).open
