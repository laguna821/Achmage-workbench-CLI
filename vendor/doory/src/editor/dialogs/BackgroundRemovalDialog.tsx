import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiOption } from '@/types/api'
import { useEditor } from '../context'
import { BACKGROUND_REMOVAL_TASK, type BgRemovalPhase } from '../engine/bgRemoval'
import { deviceChoices, loadBackgroundRemovalChoices, type BgRemovalChoices } from '../hooks/useBackgroundRemovalOptions'
import { t } from '../strings'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { describeFailure } from './bgRemovalFailure'
import styles from './dialogs.module.css'

type Status =
  | { kind: 'loading' }
  | { kind: 'choose' }
  | { kind: 'running'; option: AiOption; phase: BgRemovalPhase; percent: number }
  | { kind: 'error'; option: AiOption | null; message: string; retry: boolean }

function runningStatus(option: AiOption): Status {
  return { kind: 'running', option, phase: option.kind === 'device' ? 'downloading' : 'processing', percent: 0 }
}

/** Where the dialog starts: one option that keeps the image here runs at once; otherwise the user picks (and sees the notice of an option that sends the image away). */
function firstStatus(choices: BgRemovalChoices): Status {
  const only = choices.options.length === 1 ? choices.options[0] : null
  if (choices.options.length === 0) return { kind: 'error', option: null, message: t.bgRemoval.unavailable, retry: false }
  if (only && !only.sends_offsite) return runningStatus(only)
  return { kind: 'choose' }
}

function optionHint(option: AiOption): string {
  if (option.kind === 'device') return t.bgRemoval.deviceHint
  if (option.owner === 'user') return t.bgRemoval.ownServerHint(option.provider_name)
  return option.sends_offsite ? t.bgRemoval.externalHint : t.bgRemoval.serverHint
}

/**
 * Runs AI background removal with a progress bar; degrades to a clear error when offline or blocked. With more
 * than one option (the in-browser model, the site's servers, the user's own), the user picks one first; the
 * last pick is remembered. A failed server run offers the in-browser model instead.
 */
export function BackgroundRemovalDialog() {
  const editor = useEditor()
  const ai = editor.adapter.services.ai
  // Without server options the choice is known at once and the removal starts right away.
  const [ready] = useState<BgRemovalChoices | null>(() => (ai ? null : deviceChoices()))
  const [choices, setChoices] = useState<BgRemovalChoices | null>(ready)
  const [selected, setSelected] = useState<string | null>(ready?.initial ?? null)
  const [status, setStatus] = useState<Status>(() => (ready ? firstStatus(ready) : { kind: 'loading' }))
  const controller = useRef<AbortController>(new AbortController())
  const opened = useRef(false)
  const closedRef = useRef(false)

  /** Runs `option`; the dialog shows its progress, closes when done or shows what went wrong. */
  const run = useCallback(
    (option: AiOption): void => {
      if (closedRef.current) return
      controller.current.abort()
      const current = new AbortController()
      controller.current = current
      editor.style
        .removeBackground(
          (phase, percent) => {
            if (!current.signal.aborted && !closedRef.current) setStatus({ kind: 'running', option, phase, percent })
          },
          current.signal,
          option.id,
        )
        .then((applied) => {
          if (current.signal.aborted || closedRef.current) return
          editor.closeDialog()
          if (applied) editor.toast(t.errors.bgRemovalDone, 'success')
        })
        .catch((err: unknown) => {
          if (current.signal.aborted || closedRef.current) return
          setStatus({ kind: 'error', option, ...describeFailure(err, option) })
        })
    },
    [editor],
  )

  const start = useCallback(
    (option: AiOption): void => {
      setStatus(runningStatus(option))
      run(option)
    },
    [run],
  )

  // Once; StrictMode's second effect run finds it opened already.
  useEffect(() => {
    let cancelled = false
    if (opened.current) return
    opened.current = true
    if (ready) {
      const first = firstStatus(ready)
      if (first.kind === 'running') run(first.option)
      return
    }
    void loadBackgroundRemovalChoices(ai).then((next) => {
      if (cancelled || closedRef.current || controller.current.signal.aborted) return
      setChoices(next)
      setSelected(next.initial)
      const first = firstStatus(next)
      setStatus(first)
      if (first.kind === 'running') run(first.option)
    })
    return () => {
      cancelled = true
      closedRef.current = true
      controller.current.abort()
    }
  }, [ai, ready, run])

  const options = choices?.options ?? []
  const device = options.find((option) => option.kind === 'device') ?? null
  const chosen = options.find((option) => option.id === selected) ?? null

  const confirm = (): void => {
    if (!chosen) return
    if (options.length > 1) ai?.remember(BACKGROUND_REMOVAL_TASK, chosen.id)
    start(chosen)
  }

  const close = (): void => {
    closedRef.current = true
    controller.current.abort()
    editor.closeDialog()
  }

  const failedOnServer = status.kind === 'error' && status.option?.kind === 'server'
  const notice = ai?.offsiteNotice || t.bgRemoval.offsite
  const shownOption = status.kind === 'running' ? status.option : status.kind === 'choose' ? chosen : null

  return (
    <Dialog
      title={t.toolbar.removeBackground}
      onClose={close}
      width={440}
      footer={
        status.kind === 'error' ? (
          <>
            <Button onClick={close}>{t.dialog.close}</Button>
            {failedOnServer && options.length > 1 ? <Button onClick={() => setStatus({ kind: 'choose' })}>{t.bgRemoval.otherOption}</Button> : null}
            {failedOnServer && device ? (
              <Button variant="primary" onClick={() => start(device)}>
                {t.bgRemoval.retryOnDevice}
              </Button>
            ) : status.retry && status.option ? (
              <Button variant="primary" onClick={() => status.option && start(status.option)}>
                {t.panels.retry}
              </Button>
            ) : null}
          </>
        ) : status.kind === 'choose' ? (
          <>
            <Button onClick={close}>{t.dialog.cancel}</Button>
            <Button variant="primary" disabled={!chosen} onClick={confirm}>
              {t.bgRemoval.start}
            </Button>
          </>
        ) : (
          <Button onClick={close}>{t.dialog.cancel}</Button>
        )
      }
    >
      <div className={styles.stack}>
        {status.kind === 'loading' ? (
          <p role="status" className={styles.muted}>
            {t.bgRemoval.loading}
          </p>
        ) : status.kind === 'choose' ? (
          <div role="radiogroup" aria-label={t.bgRemoval.choose} className={styles.modes}>
            {options.map((option) => (
              <label key={option.id} className={`${styles.mode} ${option.id === selected ? styles.modeOn : ''}`}>
                <input type="radio" name="bg-removal-option" value={option.id} checked={option.id === selected} onChange={() => setSelected(option.id)} />
                <span>
                  <strong>{option.label}</strong>
                  <small>{optionHint(option)}</small>
                </span>
              </label>
            ))}
          </div>
        ) : status.kind === 'running' ? (
          <>
            <p role="status" className={styles.muted}>
              {status.option.kind === 'server' ? t.bgRemoval.serverProcessing : status.phase === 'downloading' ? t.errors.bgRemovalDownloading : t.errors.bgRemovalProcessing}
            </p>
            {status.option.kind === 'server' ? (
              <div role="progressbar" aria-label={t.toolbar.removeBackground} className={`${styles.progress} ${styles.progressIndeterminate}`}>
                <div />
              </div>
            ) : (
              <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.percent} aria-label={t.toolbar.removeBackground} className={styles.progress}>
                <div style={{ width: `${Math.max(4, status.percent)}%` }} />
              </div>
            )}
          </>
        ) : (
          <p role="alert" className={styles.error}>
            {status.message}
          </p>
        )}
        {shownOption?.sends_offsite ? (
          <p className={styles.muted} data-testid="bg-removal-offsite">
            {notice}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
