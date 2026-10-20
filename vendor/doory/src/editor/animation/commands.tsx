/**
 * Registry commands of animation: the timeline, playing the page, and the Animate panel. Their ids start with `view.`
 * so they stay available in view-only and comment-only links (anyone who can see the design can play it).
 */
import { Clapperboard, Play, Sparkles } from 'lucide-react'
import { registerCommand } from '../commands'
import { t } from '../strings'
import { toggleTimeline } from '../workspace/timelineVisibility'
import { playbackOf } from './playback'
import { pageHasAnimation } from './model'
import { previewLengthMs } from './timelineMath'

registerCommand({ id: 'view.timeline', label: t.animation.cmd.timeline, shortcut: 'Shift+T', group: t.cmdGroup.view, icon: <Clapperboard size={18} />, run: (e) => toggleTimeline(e) })

registerCommand({
  id: 'view.playPage',
  label: t.animation.cmd.playPage,
  shortcut: 'Shift+Enter',
  group: t.cmdGroup.view,
  icon: <Play size={18} />,
  run: (e) => {
    const page = e.getPage(e.state.activePageId)
    if (page) playbackOf(e).toggle(previewLengthMs(page))
  },
  enabled: ({ editor, state }) => {
    const page = editor.getPage(state.activePageId)
    return !!page && pageHasAnimation(page)
  },
})

registerCommand({ id: 'view.animate', label: t.animation.cmd.animate, group: t.cmdGroup.view, icon: <Sparkles size={18} />, run: (e) => e.patchUi({ panelId: e.state.ui.panelId === 'animate' ? null : 'animate' }), enabled: ({ state }) => !state.readOnly })
