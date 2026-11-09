import {
  openClientSecureChannel,
  type ClientSecureChannelOptions,
  type Transport,
} from "@getpaseo/relay/e2ee";

/** Use Paseo's original handshake, framing and cancellation as one module.
 * Device enrollment and Workbench command admission belong above this channel. */
export function openWorkbenchClientChannel(transport: Transport, options: Omit<ClientSecureChannelOptions, "minimumMode">) {
  return openClientSecureChannel(transport, { ...options, minimumMode: "protected" });
}
export type { SecureChannel, SecureChannelEvents, Transport } from "@getpaseo/relay/e2ee";
