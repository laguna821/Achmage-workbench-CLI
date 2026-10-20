/**
 * jsdom does not decode images. This stub makes `HTMLImageElement` "load" synchronously-ish with a fixed
 * natural size so Fabric image objects can be created in unit tests.
 */
export function installImageStub(size = { width: 10, height: 10 }): () => void {
  const proto = HTMLImageElement.prototype
  const srcDesc = Object.getOwnPropertyDescriptor(proto, 'src')
  const sizeDescs = (['naturalWidth', 'naturalHeight', 'width', 'height', 'complete'] as const).map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const)
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get(this: HTMLImageElement & { __src?: string }) {
      return this.__src ?? ''
    },
    set(this: HTMLImageElement & { __src?: string }, value: string) {
      this.__src = value
      queueMicrotask(() => this.onload?.(new Event('load')))
    },
  })
  Object.defineProperty(proto, 'naturalWidth', { configurable: true, get: () => size.width })
  Object.defineProperty(proto, 'naturalHeight', { configurable: true, get: () => size.height })
  Object.defineProperty(proto, 'width', { configurable: true, get: () => size.width })
  Object.defineProperty(proto, 'height', { configurable: true, get: () => size.height })
  Object.defineProperty(proto, 'complete', { configurable: true, get: () => true })
  return () => {
    if (srcDesc) Object.defineProperty(proto, 'src', srcDesc)
    for (const [k, d] of sizeDescs) {
      if (d) Object.defineProperty(proto, k, d)
      else Reflect.deleteProperty(proto, k)
    }
  }
}
