import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocPage } from '@/types/document'
import type { EditorEngine } from '../../engine/editor'
import { hostOf } from '../../engine/export/video/formats'
import type { VideoOptions } from '../../engine/export/video/options'
import type { VideoProgress, VideoResult } from '../../engine/export/video/types'
import { t } from '../../strings'
import { type VideoFailure, describeVideoFailure } from './failure'

export type JobState =
  | { phase: 'idle' }
  | { phase: 'working'; progress: VideoProgress | null }
  | { phase: 'done'; result: VideoResult; url: string }
  | { phase: 'failed'; failure: VideoFailure }

export interface StartInput {
  pages: { page: DocPage; index: number }[]
  options: VideoOptions
}

/**
 * Runs one export at a time for the dialog and keeps what it needs to show: progress, the finished file (with an object
 * URL for the preview, released when the file is dropped), or what went wrong. The pipeline is loaded by the first
 * `start`; closing the dialog (unmounting) cancels a running export.
 */
export function useVideoJob(editor: EditorEngine) {
  const [state, setState] = useState<JobState>({ phase: 'idle' })
  const abort = useRef<AbortController | null>(null)
  const preview = useRef<string | null>(null)

  const release = useCallback((): void => {
    if (preview.current) URL.revokeObjectURL(preview.current)
    preview.current = null
  }, [])

  useEffect(
    () => () => {
      abort.current?.abort()
      release()
    },
    [release],
  )

  const start = useCallback(
    async (input: StartInput): Promise<void> => {
      release()
      const controller = new AbortController()
      abort.current = controller
      setState({ phase: 'working', progress: null })
      try {
        const { runVideoExport } = await import('../../engine/export/video/pipeline')
        const result = await runVideoExport({
          host: hostOf(editor),
          document: editor.state.doc,
          pages: input.pages,
          options: input.options,
          title: editor.state.title,
          signal: controller.signal,
          onProgress: (progress) => setState((current) => (current.phase === 'working' ? { phase: 'working', progress } : current)),
        })
        if (controller.signal.aborted) return
        preview.current = URL.createObjectURL(result.blob)
        setState({ phase: 'done', result, url: preview.current })
      } catch (error) {
        const failure = describeVideoFailure(error)
        if (failure === null) {
          if (abort.current === controller) editor.toast(t.video.cancelled)
          setState({ phase: 'idle' })
        } else setState({ phase: 'failed', failure })
      }
    },
    [editor, release],
  )

  const cancel = useCallback((): void => abort.current?.abort(), [])

  const reset = useCallback((): void => {
    release()
    setState({ phase: 'idle' })
  }, [release])

  return { state, start, cancel, reset }
}
