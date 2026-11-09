import { expect, it } from "vitest";
import { exportPublicKey, generateKeyPair, type Transport } from "@getpaseo/relay/e2ee";
import { openWorkbenchClientChannel } from "./secure-channel.ts";
import { openWorkbenchHostChannel } from "../../../apps/host/src/devices/secure-channel.ts";
// Reuse upstream interoperability vectors and replay/tamper cases directly.
import "../../../vendor/paseo/relay/src/noise/noise.test.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

it("connects Workbench endpoints through the original Paseo protected channel", async () => {
  const wire: (string | ArrayBuffer)[] = [];
  let host!: Transport, client!: Transport;
  const port = (peer: () => Transport): Transport => ({
    send(data) { wire.push(data); queueMicrotask(() => peer().onmessage?.({ data, isBinary: typeof data !== "string" })); },
    close(code = 1000, reason = "") { queueMicrotask(() => peer().onclose?.(code, reason)); },
    onmessage: null, onclose: null, onerror: null,
  });
  host = port(() => client); client = port(() => host);
  const keys = generateKeyPair();
  const receive = deferred<string | ArrayBuffer>();
  const ready = deferred<void>();
  const opening = openWorkbenchHostChannel(host, { daemonKeyPair: keys, events: { onmessage: receive.resolve } });
  const initiator = await openWorkbenchClientChannel(client, { daemonPublicKeyB64: exportPublicKey(keys.publicKey), events: { onopen: ready.resolve } });
  const responder = await opening;
  try {
    await ready.promise;
    expect([initiator.securityMode(), responder.securityMode()]).toEqual(["protected", "protected"]);
    const request = JSON.stringify({ workId: "same-work", commandId: "same-command", text: "한글 원문" });
    await initiator.send(request);
    expect(await receive.promise).toBe(request);
    expect(wire.some(frame => typeof frame === "string" && frame.includes("한글 원문"))).toBe(false);
  } finally { initiator.close(); responder.close(); }
});
