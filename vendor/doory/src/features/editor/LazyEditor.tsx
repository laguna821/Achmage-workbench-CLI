import { lazy, Suspense, type Ref } from 'react'
import type { EditorAppProps, EditorHandle } from '@/types/adapter'
import { EditorSkeleton } from './EditorStates'
import styles from './LazyEditor.module.css'

const EditorApp = lazy(async () => {
  const module = await import('@/editor')
  return { default: module.EditorApp }
})

/** The editor lives in its own chunk; the shell only pays for it on editor routes. */
export function LazyEditor(props: EditorAppProps & { editorRef?: Ref<EditorHandle> }) {
  const { editorRef, ...rest } = props
  return (
    <Suspense fallback={<EditorSkeleton />}>
      <div className={styles.frame}>
        <EditorApp ref={editorRef} {...rest} />
      </div>
    </Suspense>
  )
}
