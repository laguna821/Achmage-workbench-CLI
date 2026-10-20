import type { BgRemovalFailure } from '../bgRemoval'
import type { ModelDescriptor } from './model'

/** Messages between the editor and the cut-out worker. Every `run` has an id; replies carry it back. */
export type WorkerRequest =
  | { type: 'init'; model: ArrayBuffer; descriptor: ModelDescriptor; wasmUrl: string; threads: number }
  | { type: 'run'; id: number; image: Blob; feather: number }
  | { type: 'cancel'; id: number }

export type WorkerReply =
  | { type: 'ready' }
  | { type: 'progress'; id: number; percent: number }
  | { type: 'done'; id: number; png: Blob }
  | { type: 'failed'; id: number | null; reason: BgRemovalFailure | 'cancelled'; message: string }
