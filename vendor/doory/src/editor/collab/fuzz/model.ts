/**
 * An in-process model of several editors co-editing one design: each peer is a real `DocBinding` and a real
 * `LocalUndo` over its own `Y.Doc`, a hub plays the server, and updates travel through queues that a script can
 * delay, duplicate, reorder and cut (offline). The model runs a script of steps (fuzz/ops.ts) and checks, after
 * the steps and at the end, everything that must hold however the network behaved:
 *
 * - all replicas converge to the same state, and every editor shows exactly what the shared state says;
 * - the shared state is a design the server would save (fuzz/serverRules.ts) at every moment, not only at the end;
 * - updates that come from other people never create an undo step;
 * - undoing or redoing never deletes something somebody else wrote (a shape only goes when its owner's parent goes);
 * - with edits made one at a time and everybody caught up in between, the shared design is exactly what applying
 *   the same edits to a plain document gives (no lost acknowledged edit).
 *
 * Everything is deterministic for a script: ids, client ids and the clock are fixed, nothing awaits a timer.
 */
import * as Y from 'yjs'
import type { DoryDocument } from '@/types/document'
import { jsonEqual } from '../../engine/json'
import { DocBinding, LOCAL_ORIGIN, REPLACE_ORIGIN } from '../binding'
import { hasNoPages, readDocument, restoreBlankPage, rootsOf, writeDocument } from '../schema'
import { newSharedDoc } from '../room'
import { LocalUndo, type Place } from '../undo'
import { Random } from '../testing'
import { OP_KINDS, type OpKind, type Step, type StepKind, applyStep, makeSeedDoc, withRepeatableIds } from './ops'
import { serverProblems } from './serverRules'

const NET = Symbol('fuzz.net')
const PLACE: Place = { activePageId: '', selection: [] }
const HUB_CLIENT = 7
const SEED_CLIENT = 6

export interface Script {
  /** The seed the design is generated from (`makeSeedDoc`). */
  doc: number
  peers: number
  /** Edits one at a time with everybody caught up in between: the shared design must equal the plain result. */
  sequential?: boolean
  steps: Step[]
}

export type FailureKind = 'exception' | 'diverged' | 'editor-differs' | 'invalid-state' | 'history-from-remote' | 'undo-reverted-peer' | 'pending' | 'lost-edit' | 'binding-invalid'

export interface Failure {
  kind: FailureKind
  /** Index of the step after which it was noticed (steps.length for the final checks). */
  at: number
  detail: string
}

interface Message {
  update: Uint8Array
  /** The design was replaced (a version restore): receivers forget their undo steps and read everything again. */
  replaced: boolean
}

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null))

/** The undo manager of a `LocalUndo`, for counting steps (the class keeps it private). */
const managerOf = (steps: LocalUndo): Y.UndoManager => (steps as unknown as { manager: Y.UndoManager }).manager

/* ------------------------------------------------------------------------------------------------
 * Who wrote what
 * ------------------------------------------------------------------------------------------------ */

/** Every live element of the shared state written by somebody other than `me`: 'client:clock' → client. */
function foreignElements(ydoc: Y.Doc, me: number): Map<string, number> {
  const out = new Map<string, number>()
  const visit = (type: Y.AbstractType<unknown>): void => {
    const items: Y.Item[] = [...type._map.values()]
    for (let item = type._start; item !== null; item = item.right) items.push(item)
    for (const item of items) {
      if (item.deleted) continue
      if (item.id.client !== me) for (let k = 0; k < item.length; k++) out.set(`${item.id.client}:${item.id.clock + k}`, item.id.client)
      if (item.content instanceof Y.ContentType) visit(item.content.type)
    }
  }
  for (const name of ['meta', 'pageOrder', 'pages']) {
    const type = ydoc.share.get(name)
    if (type) visit(type as Y.AbstractType<unknown>)
  }
  return out
}

/** Elements from `before` that are gone although the thing that held them is still there. */
function removedByMistake(ydoc: Y.Doc, before: Map<string, number>): string[] {
  const lost: string[] = []
  for (const key of before.keys()) {
    const [client, clock] = key.split(':').map(Number)
    const struct = Y.getItem(ydoc.store, Y.createID(client, clock))
    if (!(struct instanceof Y.Item) || !struct.deleted) continue
    let holder: unknown = struct.parent
    let withParent = false
    while (holder instanceof Y.AbstractType) {
      const item: Y.Item | null = holder._item
      if (item === null) break
      if (item.deleted) {
        withParent = true
        break
      }
      holder = item.parent
    }
    if (!withParent) lost.push(key)
  }
  return lost
}

/* ------------------------------------------------------------------------------------------------
 * The peers
 * ------------------------------------------------------------------------------------------------ */

class ModelPeer {
  readonly ydoc: Y.Doc
  doc: DoryDocument
  joined = false
  online = false
  outbox: Message[] = []
  inbox: Message[] = []
  past: DoryDocument[] = []
  readonly binding: DocBinding
  readonly steps: LocalUndo

  constructor(
    readonly index: number,
    readonly base: DoryDocument,
    clock: () => number,
    onInvalid: () => void,
    sabotage: boolean,
    collectGarbage: boolean,
  ) {
    this.ydoc = collectGarbage ? new Y.Doc() : newSharedDoc()
    this.ydoc.clientID = 1000 + index
    this.doc = base
    this.binding = new DocBinding(this.ydoc, {
      document: () => this.doc,
      saved: () => this.base,
      apply: async (doc) => {
        if (!sabotage) this.doc = doc
      },
      persistInline: async (doc) => doc,
      onInvalid,
      onUploadFailed: () => undefined,
      beginUpload: () => this.steps.begin({ label: 'Edit', before: PLACE, after: PLACE }),
      canWrite: () => true,
    })
    this.steps = new LocalUndo(this.binding.roots, LOCAL_ORIGIN, () => undefined, clock)
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== NET) this.outbox.push({ update, replaced: origin === REPLACE_ORIGIN })
    })
  }

  get stackSizes(): string {
    const manager = managerOf(this.steps)
    return `${manager.undoStack.length}/${manager.redoStack.length}`
  }

  /** What the shared state holds, read from scratch. */
  read(): DoryDocument | null {
    return readDocument(rootsOf(this.ydoc), null)
  }

  stop(): void {
    this.binding.stop()
    this.steps.destroy()
    this.ydoc.destroy()
  }
}

class Abort extends Error {
  constructor(readonly failure: Failure) {
    super(failure.detail)
  }
}

export interface RunOptions {
  /** Collect the updates the hub received (to replay them against the real server). */
  record?: boolean
  /** Test seam: the editors ignore every document the binding hands them, which the checks must notice. */
  sabotage?: boolean
  /** Test seam: editors use Yjs' default of collecting deleted content, which breaks undo (see `newSharedDoc`). */
  collectGarbage?: boolean
  /** The server puts a blank page back when every page is gone (default). Off, only the editors do. */
  serverRepair?: boolean
}

export interface Recording {
  initial: Uint8Array
  updates: Uint8Array[]
  document: DoryDocument
}

class Cluster {
  readonly hub = new Y.Doc()
  readonly peers: ModelPeer[] = []
  readonly doc0: DoryDocument
  private time = 0
  private reference: DoryDocument
  private position = 0
  readonly log: Uint8Array[] = []
  readonly initial: Uint8Array

  constructor(
    private readonly script: Script,
    private readonly options: RunOptions,
  ) {
    this.doc0 = makeSeedDoc(script.doc)
    this.reference = this.doc0
    const seed = new Y.Doc()
    seed.clientID = SEED_CLIENT
    writeDocument(seed, this.doc0)
    this.hub.clientID = HUB_CLIENT
    Y.applyUpdate(this.hub, Y.encodeStateAsUpdate(seed))
    this.initial = Y.encodeStateAsUpdate(this.hub)
    seed.destroy()
    for (let i = 0; i < script.peers; i++) this.peers.push(new ModelPeer(i, this.doc0, () => this.time, () => this.fail('binding-invalid', `peer ${i}: the shared state is not a design`), options.sabotage === true, options.collectGarbage === true))
  }

  fail(kind: FailureKind, detail: string): never {
    throw new Abort({ kind, at: this.position, detail })
  }

  /* ----------------------------------------------------------------------------- network */

  private hubReceive(from: ModelPeer, message: Message): void {
    Y.applyUpdate(this.hub, message.update, from)
    this.log.push(message.update)
    for (const peer of this.peers) if (peer !== from && peer.joined && peer.online) peer.inbox.push(message)
    this.hubChanged()
  }

  /** What the server does after it took in a change: put a blank page back if none is left, and see that it could still save. */
  private hubChanged(): void {
    if (this.options.serverRepair !== false && hasNoPages(rootsOf(this.hub))) {
      const before = Y.encodeStateVector(this.hub)
      this.hub.transact(() => restoreBlankPage(rootsOf(this.hub)), 'server')
      const update = Y.encodeStateAsUpdate(this.hub, before)
      this.log.push(update)
      for (const peer of this.peers) if (peer.joined && peer.online) peer.inbox.push({ update, replaced: false })
    }
    if (this.options.serverRepair === false && hasNoPages(rootsOf(this.hub))) return
    this.checkHub()
  }

  private send(peer: ModelPeer, count: number): void {
    if (!peer.joined || !peer.online) return
    for (const message of peer.outbox.splice(0, count)) this.hubReceive(peer, message)
  }

  private async receive(peer: ModelPeer, count: number): Promise<void> {
    if (!peer.joined || !peer.online) return
    for (const message of peer.inbox.splice(0, count)) {
      const sizes = peer.stackSizes
      Y.applyUpdate(peer.ydoc, message.update, NET)
      if (message.replaced) {
        peer.steps.clear()
        await peer.binding.resync()
      } else if (peer.stackSizes !== sizes) this.fail('history-from-remote', `peer ${peer.index}: undo/redo stacks ${sizes} -> ${peer.stackSizes} after a remote update`)
    }
  }

  /** The handshake of a (re)connection: both sides send what the other lacks. */
  private reconcile(peer: ModelPeer): void {
    const up = Y.encodeStateAsUpdate(peer.ydoc, Y.encodeStateVector(this.hub))
    const down = Y.encodeStateAsUpdate(this.hub, Y.encodeStateVector(peer.ydoc))
    peer.outbox = []
    peer.inbox = []
    if (!isEmptyUpdate(up)) {
      Y.applyUpdate(this.hub, up, peer)
      this.log.push(up)
      for (const other of this.peers) if (other !== peer && other.joined && other.online) other.inbox.push({ update: up, replaced: false })
      this.hubChanged()
    }
    const sizes = peer.stackSizes
    Y.applyUpdate(peer.ydoc, down, NET)
    if (peer.stackSizes !== sizes) this.fail('history-from-remote', `peer ${peer.index}: stacks changed by the handshake`)
  }

  private join(peer: ModelPeer): void {
    if (peer.joined) return
    peer.joined = true
    peer.online = true
    Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(this.hub), NET)
    peer.binding.synchronised()
    // Whatever the editor wrote on top of the server's copy while it connected goes out like any other change.
    this.send(peer, Number.MAX_SAFE_INTEGER)
  }

  private checkHub(): void {
    const read = readDocument(rootsOf(this.hub), null)
    if (!read) {
      const roots = rootsOf(this.hub)
      this.fail('invalid-state', `the shared state is not a design: ${roots.pageOrder.length} listed page(s), ${roots.pages.size} page entries, meta ${JSON.stringify(roots.meta.toJSON())}`)
    }
    const problems = serverProblems(read)
    if (problems.length > 0) this.fail('invalid-state', `the server would refuse to save: ${problems.slice(0, 5).join('; ')}`)
  }

  /* -------------------------------------------------------------------------------- steps */

  async run(): Promise<void> {
    const { steps } = this.script
    for (this.position = 0; this.position < steps.length; this.position++) {
      const step = steps[this.position]
      this.time += step.dt
      const waiting = this.peers.map((p) => p.outbox.length)
      await this.execute(step)
      this.peers.forEach((p, i) => mergeSince(p, waiting[i]))
    }
    this.position = steps.length
    await this.finish()
  }

  private async execute(step: Step): Promise<void> {
    const peer = this.peers[step.p % this.peers.length]
    if (this.script.sequential) {
      await this.executeSequential(peer, step)
      return
    }
    switch (step.k) {
      case 'op':
        this.edit(peer, step)
        break
      case 'undo':
      case 'redo':
        if (peer.joined) await this.history(peer, step.k)
        break
      case 'seal':
        peer.steps.seal()
        break
      case 'flush':
        await this.catchUp(peer)
        break
      case 'send':
        this.send(peer, step.a % 5 === 0 ? Number.MAX_SAFE_INTEGER : 1 + (step.a % 3))
        break
      case 'recv':
        await this.receive(peer, step.a % 5 === 0 ? Number.MAX_SAFE_INTEGER : 1 + (step.a % 3))
        break
      case 'dup':
        if (peer.inbox.length > 0) peer.inbox.splice(step.b % (peer.inbox.length + 1), 0, peer.inbox[step.a % peer.inbox.length])
        break
      case 'swap':
        if (peer.inbox.length > 1) {
          const i = step.a % peer.inbox.length
          const j = step.b % peer.inbox.length
          ;[peer.inbox[i], peer.inbox[j]] = [peer.inbox[j], peer.inbox[i]]
        }
        break
      case 'offline':
        if (peer.joined && peer.online) {
          peer.online = false
          peer.outbox = []
          peer.inbox = []
        }
        break
      case 'online':
        if (peer.joined && !peer.online) {
          peer.online = true
          this.reconcile(peer)
        }
        break
      case 'join':
        this.join(peer)
        break
      case 'restore':
        this.restore(peer, step)
        break
    }
  }

  private edit(peer: ModelPeer, step: Step): DoryDocument | null {
    const edit = applyStep(peer.doc, step)
    if (!edit) return null
    const prev = peer.doc
    if (peer.binding.isSynced) {
      peer.steps.begin({ label: edit.label, coalesceKey: edit.key, before: PLACE, after: PLACE })
      peer.binding.writeLocal(prev, edit.doc)
    }
    peer.doc = edit.doc
    peer.past.push(prev)
    if (peer.past.length > 6) peer.past.shift()
    return edit.doc
  }

  private restore(peer: ModelPeer, step: Step): void {
    if (!peer.joined || peer.past.length === 0) return
    const earlier = peer.past[step.a % peer.past.length]
    const prev = peer.doc
    if (earlier === prev) return
    peer.steps.clear()
    peer.binding.writeLocal(prev, earlier, REPLACE_ORIGIN)
    peer.doc = earlier
  }

  /** The editor reads what arrived: its document must then be exactly the shared state. */
  private async catchUp(peer: ModelPeer): Promise<void> {
    if (!peer.joined) return
    const sizes = peer.stackSizes
    await peer.binding.flush()
    if (peer.stackSizes !== sizes) this.fail('history-from-remote', `peer ${peer.index}: reading the shared state changed the history ${sizes} -> ${peer.stackSizes}`)
    this.sameAsShared(peer)
  }

  private sameAsShared(peer: ModelPeer): void {
    const shared = peer.read()
    if (!shared) this.fail('invalid-state', `peer ${peer.index}: the shared state is not a design`)
    if (!jsonEqual(plain(peer.doc), plain(shared))) this.fail('editor-differs', `peer ${peer.index}: the editor shows ${firstDifference(plain(peer.doc), plain(shared))}${layoutDifference(peer.doc, shared)}`)
  }

  private async history(peer: ModelPeer, direction: 'undo' | 'redo'): Promise<void> {
    const before = foreignElements(peer.ydoc, peer.ydoc.clientID)
    if (direction === 'undo') peer.steps.undo()
    else peer.steps.redo()
    const lost = removedByMistake(peer.ydoc, before)
    if (lost.length > 0) this.fail('undo-reverted-peer', `peer ${peer.index}: ${direction} removed ${lost.length} thing(s) other people wrote, e.g. ${lost.slice(0, 3).join(', ')}`)
    await peer.binding.flush()
  }

  private async executeSequential(peer: ModelPeer, step: Step): Promise<void> {
    if (step.k !== 'op') return
    for (const p of this.peers) this.join(p)
    const edit = this.edit(peer, step)
    if (!edit) return
    this.reference = edit
    await this.settleAll()
    for (const other of this.peers) {
      const shared = other.read()
      if (!jsonEqual(plain(shared), plain(this.reference))) this.fail('lost-edit', `peer ${other.index}: the shared design differs from the plain result of ${step.op}: ${firstDifference(plain(this.reference), plain(shared))}`)
      this.sameAsShared(other)
    }
  }

  /* ----------------------------------------------------------------------------- the end */

  private async settleAll(): Promise<void> {
    for (const peer of this.peers) if (!peer.joined) this.join(peer)
    for (const peer of this.peers)
      if (!peer.online) {
        peer.online = true
        this.reconcile(peer)
      }
    for (let round = 0; round < 40; round++) {
      let busy = false
      for (const peer of this.peers) {
        if (peer.outbox.length > 0) {
          busy = true
          this.send(peer, Number.MAX_SAFE_INTEGER)
        }
      }
      for (const peer of this.peers) {
        if (peer.inbox.length > 0) {
          busy = true
          await this.receive(peer, Number.MAX_SAFE_INTEGER)
        }
      }
      if (!busy) break
    }
    // Duplicated, reordered and cut-off messages are made good by the state exchange of a reconnection.
    for (const peer of this.peers) this.reconcile(peer)
    for (const peer of this.peers) await peer.binding.flush()
    for (const peer of this.peers) {
      for (const message of peer.inbox.splice(0)) {
        Y.applyUpdate(peer.ydoc, message.update, NET)
        if (message.replaced) await peer.binding.resync()
      }
      await peer.binding.flush()
    }
  }

  private async finish(): Promise<void> {
    await this.settleAll()
    const states = [this.hub, ...this.peers.map((p) => p.ydoc)]
    const expected = plain(readDocument(rootsOf(this.hub), null))
    for (const [i, ydoc] of states.entries()) {
      const label = i === 0 ? 'the server' : `peer ${i - 1}`
      if (ydoc.store.pendingStructs !== null || ydoc.store.pendingDs !== null) this.fail('pending', `${label} still waits for history it never got`)
      if (!equalDocs(this.hub, ydoc)) this.fail('diverged', `${label} holds another state than the server`)
      const read = readDocument(rootsOf(ydoc), null)
      if (!jsonEqual(plain(read), expected)) this.fail('diverged', `${label} reads another design than the server: ${firstDifference(expected, plain(read))}\n${rawLayout(this.hub)}\n${rawLayout(ydoc)}`)
    }
    this.checkHub()
    for (const peer of this.peers) this.sameAsShared(peer)
  }

  recording(): Recording {
    return { initial: this.initial, updates: this.log, document: readDocument(rootsOf(this.hub), null) as DoryDocument }
  }

  stop(): void {
    for (const peer of this.peers) peer.stop()
    this.hub.destroy()
  }
}

/** The page and object order lists exactly as the shared document holds them (for failure messages). */
function rawLayout(ydoc: Y.Doc): string {
  const roots = rootsOf(ydoc)
  const pages = roots.pageOrder.toArray().map((id) => {
    const page = roots.pages.get(id)
    const order = page?.get('objectOrder')
    const objects = page?.get('objects')
    return `${id}: order [${order instanceof Y.Array ? order.toArray().join(',') : '-'}] entries [${objects instanceof Y.Map ? [...objects.keys()].join(',') : '-'}]`
  })
  return `  pageOrder [${roots.pageOrder.toArray().join(',')}] ${pages.join(' | ')}`
}

/** Changes made together travel together (the provider sends everything from one 40 ms window as one frame). */
function mergeSince(peer: ModelPeer, count: number): void {
  if (peer.outbox.length - count < 2) return
  const made = peer.outbox.splice(count)
  peer.outbox.push({ update: Y.mergeUpdates(made.map((m) => m.update)), replaced: made.some((m) => m.replaced) })
}

function equalDocs(a: Y.Doc, b: Y.Doc): boolean {
  return sameVector(Y.encodeStateVector(a), Y.encodeStateVector(b)) && Y.equalDeleteSets(Y.createDeleteSetFromStructStore(a.store), Y.createDeleteSetFromStructStore(b.store))
}

function sameVector(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length <= 2
}

/** Where the pages and objects of two documents are listed differently (the usual cause of a difference that looks like a changed property). */
function layoutDifference(a: DoryDocument, b: DoryDocument): string {
  const ids = (doc: DoryDocument): string[] => doc.pages.map((p) => `${p.id}[${p.objects.map((o) => o.id).join(',')}]`)
  const left = ids(a)
  const right = ids(b)
  return left.join('|') === right.join('|') ? '' : `\n  editor: ${left.join(' | ')}\n  shared: ${right.join(' | ')}`
}

/** The first place two JSON values differ, as a path and the two values (for failure messages). */
export function firstDifference(a: unknown, b: unknown, path = ''): string {
  if (jsonEqual(a, b)) return 'no difference'
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      const left = (a as Record<string, unknown>)[key]
      const right = (b as Record<string, unknown>)[key]
      if (!jsonEqual(left, right)) return firstDifference(left, right, `${path}/${key}`)
    }
  }
  const text = (v: unknown): string => (JSON.stringify(v) ?? 'undefined').slice(0, 120)
  return `${path || '/'}: ${text(a)} vs ${text(b)}`
}

/* ------------------------------------------------------------------------------------------------
 * Running, generating and shrinking scripts
 * ------------------------------------------------------------------------------------------------ */

/** Runs a script; resolves with what went wrong first, or null. */
export async function runScript(script: Script, options: RunOptions = {}): Promise<{ failure: Failure | null; recording: Recording | null }> {
  return withRepeatableIds(async () => {
    const cluster = new Cluster(script, options)
    try {
      await cluster.run()
      return { failure: null, recording: options.record ? cluster.recording() : null }
    } catch (error) {
      if (error instanceof Abort) return { failure: error.failure, recording: options.record ? cluster.recording() : null }
      const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
      return { failure: { kind: 'exception' as const, at: -1, detail }, recording: null }
    } finally {
      cluster.stop()
    }
  })
}

export interface Weights {
  op: number
  flush: number
  send: number
  recv: number
  undo: number
  redo: number
  seal: number
  dup: number
  swap: number
  offline: number
  online: number
  restore: number
}

const CHAOS: Weights = { op: 55, flush: 9, send: 12, recv: 12, undo: 6, redo: 3, seal: 1, dup: 1, swap: 1, offline: 1.5, online: 3, restore: 0.6 }
const COMMON_OPS: readonly OpKind[] = ['move', 'move', 'scale', 'fill', 'delete', 'duplicate', 'group', 'zorder', 'textEdit', 'insertShape', 'insertText', 'pageAdd', 'pageRemove', 'opacity']

export interface GenerateOptions {
  peers?: number
  steps?: number
  sequential?: boolean
  weights?: Partial<Weights>
  /** Restrict the edits to these kinds. */
  ops?: readonly OpKind[]
  /** Leave these kinds out (to look past a known problem). */
  exclude?: readonly OpKind[]
}

export function generateScript(seed: number, options: GenerateOptions = {}): Script {
  const random = new Random(seed * 104729 + 7)
  const peers = options.peers ?? 2 + random.int(3)
  const count = options.steps ?? 60
  const weights: Weights = { ...CHAOS, ...options.weights }
  const kinds = Object.entries(weights) as [keyof Weights, number][]
  const total = kinds.reduce((sum, [, w]) => sum + w, 0)
  const steps: Step[] = []
  let n = 0
  const make = (k: StepKind, p: number, op?: OpKind): Step => {
    n += 1
    const dt = random.int(10) === 0 ? 900 + random.int(1500) : random.int(60)
    // Half of the edits aim at the first few objects, so that people really do edit the same things at the same time.
    const aimed = random.bool()
    const a = aimed ? random.int(3) : random.int(1_000_000)
    const b = aimed ? random.int(3) : random.int(1_000_000)
    return { p, k, op, a, b, c: random.int(1_000_000), d: random.int(1_000_000), n, dt }
  }
  // Some editors connect late: what they do before that is rebased onto the server's copy.
  const joinAt = Array.from({ length: peers }, (_, p) => (p === 0 ? 0 : random.int(Math.max(1, Math.floor(count / 3)))))
  for (let i = 0; i < count; i++) {
    for (let p = 0; p < peers; p++) if (joinAt[p] === i) steps.push(make('join', p))
    if (options.sequential) {
      steps.push(make('op', random.int(peers), pickOp(random, options.ops, options.exclude)))
      continue
    }
    let roll = random.next() * total
    let kind: keyof Weights = 'op'
    for (const [name, weight] of kinds) {
      roll -= weight
      if (roll < 0) {
        kind = name
        break
      }
    }
    const p = random.int(peers)
    steps.push(kind === 'op' ? make('op', p, pickOp(random, options.ops, options.exclude)) : make(kind, p))
  }
  return { doc: seed, peers, sequential: options.sequential, steps }
}

function pickOp(random: Random, ops?: readonly OpKind[], exclude: readonly OpKind[] = []): OpKind {
  const pool = (ops ?? (random.int(3) === 0 ? COMMON_OPS : OP_KINDS)).filter((op) => !exclude.includes(op))
  return random.pick(pool)
}

/**
 * Removes steps while the script still fails the same way, to leave the shortest list that shows the problem.
 * Whole chunks first, then single steps, until nothing more can go.
 */
export async function shrink(script: Script, failure: Failure, budget = 400, options: RunOptions = {}): Promise<Script> {
  let best = script
  let runs = 0
  const stillFails = async (candidate: Script): Promise<boolean> => {
    runs += 1
    const { failure: f } = await runScript(candidate, options)
    return f !== null && f.kind === failure.kind
  }
  let size = Math.ceil(best.steps.length / 2)
  while (size >= 1 && runs < budget) {
    let removed = false
    for (let start = 0; start < best.steps.length && runs < budget; ) {
      const steps = [...best.steps.slice(0, start), ...best.steps.slice(start + size)]
      if (steps.length > 0 && (await stillFails({ ...best, steps }))) {
        best = { ...best, steps }
        removed = true
      } else start += size
    }
    if (!removed) size = Math.floor(size / 2)
  }
  return best
}

/** A script as a short, readable report (for failure messages and for pasting into the regression list). */
export function describeScript(script: Script): string {
  const lines = script.steps.map((s) => {
    const what = s.k === 'op' ? `op ${s.op}` : s.k
    return `  { p: ${s.p}, k: '${s.k}',${s.op ? ` op: '${s.op}',` : ''} a: ${s.a}, b: ${s.b}, c: ${s.c}, d: ${s.d}, n: ${s.n}, dt: ${s.dt} }, // ${what}`
  })
  return `doc: ${script.doc}, peers: ${script.peers}${script.sequential ? ', sequential' : ''}\n${lines.join('\n')}`
}
