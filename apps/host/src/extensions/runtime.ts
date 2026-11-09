import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSDeferredPromise } from "quickjs-emscripten-core";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import pino from "pino";
import { PluginRuntime } from "@workbench/paseo-plugin-host/runtime";
import type { PluginProcessMessage, PluginProcessRequest } from "@workbench/paseo-plugin-host/protocol";
import type { ProviderConnection } from "@getpaseo/plugin/server/provider";

type Broker = (method: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
const LIMIT_BYTES = 1024 * 1024;
let sdk: string | undefined;
let quickJS: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;
function sdkSource(): string {
  if (sdk) return sdk;
  const packaged = new URL("./extensions/guest-sdk.js", import.meta.url);
  const source = existsSync(packaged) ? packaged : new URL("../../guest-sdk.js", import.meta.resolve("@workbench/paseo-plugin-host/runtime"));
  return sdk = readFileSync(source, "utf8");
}

/** This bridge runs inside QuickJS. Original SDK validators and lifecycle names remain authoritative. */
const GUEST = String.raw`
(() => {
  const sdk = WorkbenchPaseoSdk;
  const methods = new Map(), providers = new Map(), connections = new Map(), hooks = new Map();
  const emit = value => __emit(JSON.stringify(value));
  const host = async (method, input) => JSON.parse(await __host(method, JSON.stringify(input)));
  const workbench = Object.freeze({
    readText: path => host('file.read', {path}),
    writeText: (path, text) => host('file.write', {path,text}),
    fetch: (url, options={}) => host('network.fetch', {url,...options}),
    delay: ms => host('delay', {ms}),
  });
  Object.defineProperty(globalThis, 'workbench', {value:workbench});
  const context = Object.freeze({paseo:Object.freeze({workbench})});
  const lifecycle = sdk.createLifecycleRegistration((name, fn) => {
    const set = hooks.get(name) || new Set(); set.add(fn); hooks.set(name,set);
    return () => set.delete(fn);
  });
  let cleanup = null;
  const server = Object.freeze({ ...lifecycle,
    handle(contract, fn) {
      if (!contract || typeof contract.name !== 'string' || typeof fn !== 'function' || methods.has(contract.name)) throw Error('Invalid or duplicate RPC');
      if ('event' in contract) throw Error('Subscriptions are not supported by paseo-quickjs-v1');
      methods.set(contract.name,{contract,fn});
    },
    registerProvider(provider) {
      if (!provider || !/^[a-z][a-z0-9._-]*$/.test(provider.id) || !provider.label || typeof provider.connect !== 'function' || provider.command || providers.has(provider.id)) throw Error('Invalid bounded provider');
      providers.set(provider.id,provider);
    },
    registerSettings() { throw Error('Use explicit broker input; persistent settings API is unavailable'); },
    registerUsageSource() { throw Error('Usage sources are unavailable'); },
  });
  function requireModule(name) {
    if (name === '@getpaseo/plugin') return sdk.shared;
    if (name === '@getpaseo/plugin/server') return sdk.server;
    if (name === '@getpaseo/plugin/server/provider') return sdk.provider;
    if (name === 'zod') return sdk.zod;
    throw Error('Module is not allowed: ' + name);
  }
  globalThis.__initialize = bundle => {
    const factory = (0,eval)(bundle);
    if (typeof factory !== 'function') throw Error('Invalid plugin bundle');
    const exported = factory(requireModule);
    if (typeof exported.default !== 'function') throw Error('Plugin needs a default contribution');
    cleanup = exported.default(server);
    if (cleanup && typeof cleanup.then === 'function') throw Error('Contribution setup must be synchronous');
    emit({type:'ready', methods:[...methods.keys()], providers:[...providers.values()].map(p => ({id:p.id,label:p.label,hasStatus:typeof p.status==='function'})), hooks:[...hooks.keys()]});
  };
  globalThis.__receive = async message => {
    try {
      if (message.type === 'invoke') {
        const registered = methods.get(message.method);
        if (!registered) throw Error('RPC is not registered');
        const input = await registered.contract.input.parseAsync(message.input);
        const output = await registered.contract.output.parseAsync(await registered.fn(input,context));
        emit({type:'result',requestId:message.requestId,output});
      } else if (message.type === 'provider.status') {
        const provider = providers.get(message.providerId);
        if (!provider) throw Error('Provider is not registered');
        const output = provider.status ? await provider.status({}) : {available:true};
        emit({type:'result',requestId:message.requestId,output});
      } else if (message.type === 'provider.connect') {
        try {
          const provider = providers.get(message.providerId);
          if (!provider || message.request.launch) throw Error('Provider launch is not allowed');
          const connection = await provider.connect(message.request);
          const off = connection.onEvent(event => emit({type:'provider.event',connectionId:message.connectionId,event}));
          connections.set(message.connectionId,{connection,off});
          emit({type:'provider.connected',connectionId:message.connectionId,version:connection.version,capabilities:connection.capabilities});
        } catch(error) { emit({type:'provider.connect_failed',connectionId:message.connectionId,error:String(error.message||error)}); }
      } else if (message.type === 'provider.send') {
        const entry = connections.get(message.connectionId);
        if (!entry) throw Error('Provider connection is closed');
        try {
          await entry.connection.send(sdk.provider.ProviderInputSchema.parse(message.input));
          emit({type:'provider.accepted',connectionId:message.connectionId,acceptanceId:message.acceptanceId});
        } catch(error) { emit({type:'provider.rejected',connectionId:message.connectionId,acceptanceId:message.acceptanceId,error:String(error.message||error)}); }
      } else if (message.type === 'provider.close') {
        const entry=connections.get(message.connectionId);
        if(entry) { entry.off(); await entry.connection.close(); connections.delete(message.connectionId); }
        emit({type:'provider.closed',connectionId:message.connectionId});
      } else if (message.type === 'hook') {
        let result=message.input;
        for(const hook of hooks.get(message.name)||[]) { const value=await hook(result,context); if(value!==undefined) result=value; }
        emit({type:'result',requestId:message.requestId,output:result});
      } else if (message.type === 'shutdown') {
        for(const entry of connections.values()) { entry.off(); await entry.connection.close(); }
        connections.clear(); if(typeof cleanup==='function') await cleanup();
        emit({type:'workbench.closed'});
      } else if (message.type !== 'paseo_close' && message.type !== 'paseo_frame') {
        throw Error('Unsupported bounded plugin message: '+message.type);
      }
    } catch(error) {
      if(message.requestId) emit({type:'error',requestId:message.requestId,error:String(error.message||error)});
      else emit({type:'fatal',error:String(error.message||error)});
    }
  };
})();
`;

/** Implements the original spawnChild port, with no Node/global host object crossing the VM. */
class QuickJsChild extends EventEmitter {
  connected = true;
  killed = false;
  private vm: QuickJSContext | null = null;
  private readonly abort = new AbortController();
  private deadline = 0;
  private pending = new Set<QuickJSDeferredPromise>();
  private readonly broker: Broker;
  private boot: Promise<void> | null = null;
  private outputMessages = 0;
  private outputBytes = 0;
  private hostCalls = 0;
  constructor(broker: Broker) { super(); this.broker = broker; }
  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean {
    if (!this.connected) { callback?.(new Error("QuickJS extension is closed")); return false; }
    const copy = structuredClone(message);
    queueMicrotask(() => {
      if (copy.type === "initialize") {
        this.boot = this.initialize(copy.bundle);
        void this.boot.then(() => callback?.(null), error => { this.fail(error); callback?.(asError(error)); });
      } else {
        void Promise.resolve(this.boot).then(() => {
          if (!this.connected) return;
          this.evaluate(`void __receive(${JSON.stringify(copy)})`); callback?.(null);
        }).catch(error => { this.fail(error); callback?.(asError(error)); });
      }
    });
    return true;
  }
  private async initialize(bundle: string): Promise<void> {
    // This is the identical default variant used by getQuickJS(), selected explicitly so
    // packaged apps carry one WASM engine instead of debug/asyncify variants too.
    const QuickJS = await (quickJS ??= newQuickJSWASMModuleFromVariant(RELEASE_SYNC));
    if (!this.connected) return;
    const vm = QuickJS.newContext(); this.vm = vm;
    vm.runtime.setMemoryLimit(32 * 1024 * 1024); vm.runtime.setMaxStackSize(512 * 1024);
    vm.runtime.setInterruptHandler(() => this.abort.signal.aborted || Date.now() > this.deadline);
    vm.runtime.setModuleLoader(name => { throw new Error(`Module loader is disabled: ${name}`); });
    const emit = vm.newFunction("__emit", value => {
      const json = vm.getString(value);
      this.outputBytes += Buffer.byteLength(json);
      if (++this.outputMessages > 1000 || Buffer.byteLength(json) > LIMIT_BYTES || this.outputBytes > 4 * LIMIT_BYTES) throw new Error("Extension output budget exceeded");
      const message: PluginProcessMessage | { type: "workbench.closed" } = JSON.parse(json);
      queueMicrotask(() => { if (message.type === "workbench.closed") this.disconnect(); else if (this.connected) this.emit("message", message); });
    });
    vm.setProp(vm.global, "__emit", emit); emit.dispose();
    const host = vm.newFunction("__host", (method, input) => {
      const name = vm.getString(method), json = vm.getString(input);
      if (++this.hostCalls > 64 || Buffer.byteLength(json) > LIMIT_BYTES) throw new Error("Extension broker budget exceeded");
      const deferred = vm.newPromise(); this.pending.add(deferred);
      void Promise.resolve().then(() => this.broker(name, JSON.parse(json), this.abort.signal)).then(
        output => this.settle(deferred, JSON.stringify(output ?? null), false),
        error => this.settle(deferred, asError(error).message, true),
      );
      return deferred.handle;
    });
    vm.setProp(vm.global, "__host", host); host.dispose();
    this.evaluate(sdkSource()); this.evaluate(GUEST); this.evaluate(`__initialize(${JSON.stringify(bundle)})`);
  }
  private settle(promise: QuickJSDeferredPromise, text: string, failed: boolean): void {
    const vm = this.vm;
    if (!vm || !this.pending.delete(promise)) return;
    try {
      if (Buffer.byteLength(text) > LIMIT_BYTES) { text = "Extension broker output is too large"; failed = true; }
      const value = failed ? vm.newError(text) : vm.newString(text);
      if (failed) promise.reject(value); else promise.resolve(value);
      value.dispose(); promise.dispose(); this.pump();
    } catch (error) { this.fail(error); }
  }
  private evaluate(code: string): void {
    if (!this.vm) throw new Error("QuickJS is not ready");
    this.deadline = Date.now() + 1000;
    this.vm.unwrapResult(this.vm.evalCode(code, "workbench-extension.js")).dispose(); this.pump();
  }
  private pump(): void {
    const vm = this.vm; if (!vm) return;
    this.deadline = Date.now() + 1000;
    while (vm.runtime.hasPendingJob()) {
      const result = vm.runtime.executePendingJobs(100);
      if (result.error) { const error = vm.dump(result.error); result.error.dispose(); throw new Error(String(error?.message ?? error)); }
      if (Date.now() > this.deadline) throw new Error("Extension CPU budget exceeded");
    }
  }
  private fail(error: unknown): void { if (this.connected) this.emit("message", { type: "fatal", error: asError(error).message }); this.disconnect(); }
  kill(): boolean { if (this.killed) return false; this.killed = true; this.disconnect(); return true; }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false; this.abort.abort();
    for (const promise of this.pending) promise.dispose(); this.pending.clear();
    const vm = this.vm; this.vm = null; vm?.dispose();
    this.emit("close", 0, null);
  }
}
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

/** One upstream runtime per owned operation prevents broker authority leaking between callers. */
export class ExtensionRuntime {
  private readonly runtime: PluginRuntime;
  private readonly children = new Set<QuickJsChild>();
  private pluginId: string | null = null;
  private stopped = false;
  constructor(broker: Broker) {
    this.runtime = new PluginRuntime(pino({ level: "silent" }), "0.15.3", {
      spawnChild: () => { if (this.stopped) throw new Error("Extension operation was cancelled"); const child = new QuickJsChild(broker); this.children.add(child); child.once("close", () => this.children.delete(child)); return child; },
      // No Paseo owner API is granted. Every useful import is an explicit Workbench broker call.
      sessionHost: { attachPluginSocket: async (_id, socket) => ({ closed: new Promise<void>(resolve => { socket.once("close", () => resolve()); socket.on("message", () => socket.close(1008, "No daemon owner API in bounded runtime")); }) }) },
    });
  }
  async start(id: string, directory: string): Promise<void> { this.pluginId = id; await this.runtime.startPlugin(id, directory, () => !this.stopped); }
  invoke(method: string, input: unknown): Promise<unknown> { return this.runtime.invoke(this.requireId(), method, input); }
  providers() { return this.runtime.getProviderRegistrations(this.requireId()); }
  providerStatus(id: string) { return this.runtime.getProviderStatus(this.requireId(), id, {}); }
  connectProvider(id: string): Promise<ProviderConnection> { return this.runtime.connectProvider(this.requireId(), id, { versions: [1], capabilities: ["prompt.message"] }); }
  async close(): Promise<void> {
    this.stopped = true;
    // Abort host requests and VM execution immediately; the original runtime rejects its pending RPCs.
    for (const child of [...this.children]) child.kill();
    if (this.pluginId) await this.runtime.stopPluginById(this.pluginId); this.pluginId = null;
  }
  private requireId(): string { if (!this.pluginId) throw new Error("Extension runtime is not started"); return this.pluginId; }
}
