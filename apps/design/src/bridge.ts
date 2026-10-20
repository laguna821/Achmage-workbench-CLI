import type { DesignHostMessage, DesignPageMessage } from "@workbench/contracts";

// The design page only talks to the Workbench window that embeds it (same origin, parent frame).

export function post(message: DesignPageMessage) {
  if (window.parent !== window) window.parent.postMessage(message, location.origin);
}

export function listen(handler: (message: DesignHostMessage) => void) {
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    const message = event.data as DesignHostMessage;
    if (message && typeof message.type === "string") handler(message);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/** Resolves with the first message of the given type. */
export function next<T extends DesignHostMessage["type"]>(type: T): Promise<Extract<DesignHostMessage, { type: T }>> {
  return new Promise((resolve) => {
    const stop = listen((message) => {
      if (message.type !== type) return;
      stop();
      resolve(message as Extract<DesignHostMessage, { type: T }>);
    });
  });
}
