import {
  openDaemonSecureChannel,
  type DaemonSecureChannelOptions,
  type Transport,
} from "@getpaseo/relay/e2ee";

/** The original Paseo endpoint owns all cryptography and wire framing.
 * Opening this channel does not authorize a device or a Workbench command. */
export function openWorkbenchHostChannel(transport: Transport, options: Omit<DaemonSecureChannelOptions, "minimumMode">) {
  return openDaemonSecureChannel(transport, { ...options, minimumMode: "protected" });
}
