/** Wire schema ranges are additive payload compatibility, independent of the on-disk DB version. */
export type ProtocolDescriptor = { major: number; minor: number; schema: { min: number; max: number; current: number } };
export type ProtocolHandshake = { server: ProtocolDescriptor; client: ProtocolDescriptor; read: boolean; write: boolean; schema: number | null; legacy: boolean; reason: string | null };
export const PROTOCOL_HEADER = "x-workbench-protocol";
export const WORKBENCH_PROTOCOL: ProtocolDescriptor = { major: 1, minor: 1, schema: { min: 0, max: 1, current: 1 } };
/** 0.3.x and existing local IPC have the same additive v1 payloads, before descriptor headers. */
export const LEGACY_PROTOCOL: ProtocolDescriptor = { major: 1, minor: 0, schema: { min: 0, max: 0, current: 0 } };
export function protocolHeader(protocol = WORKBENCH_PROTOCOL) { return JSON.stringify(protocol); }
export function parseProtocol(value: unknown): ProtocolDescriptor | null {
  try {
    const p = typeof value === "string" ? JSON.parse(value) : value;
    if (!p || typeof p !== "object" || ![p.major, p.minor, p.schema?.min, p.schema?.max, p.schema?.current].every(n => Number.isSafeInteger(n) && n >= 0)
      || p.major < 1 || p.schema.min > p.schema.current || p.schema.current > p.schema.max) return null;
    return { major: p.major, minor: p.minor, schema: { min: p.schema.min, max: p.schema.max, current: p.schema.current } };
  } catch { return null; }
}
export function negotiateProtocol(client: ProtocolDescriptor, server = WORKBENCH_PROTOCOL, legacy = false): ProtocolHandshake {
  const schema = Math.min(client.schema.max, server.schema.max);
  const read = client.major === server.major && schema >= Math.max(client.schema.min, server.schema.min);
  const write = read && client.minor <= server.minor;
  return { server, client, read, write, schema: read ? schema : null, legacy,
    reason: client.major !== server.major ? "클라이언트와 호스트의 프로토콜 major가 다릅니다. 같은 릴리즈로 업데이트해 주세요."
      : !read ? "클라이언트와 호스트가 공통 데이터 형식을 지원하지 않습니다."
      : !write ? "호스트가 더 오래된 minor 버전입니다. 새 요청을 보내기 전에 호스트를 업데이트해 주세요." : null };
}
export function handshakeFromHeader(value: unknown): ProtocolHandshake {
  const legacy = value === undefined || value === null || value === "";
  const client = legacy ? LEGACY_PROTOCOL : parseProtocol(value);
  if (!client) throw Object.assign(Error("프로토콜 협상 정보가 올바르지 않습니다."), { status: 400, code: "protocol_invalid" });
  return negotiateProtocol(client, WORKBENCH_PROTOCOL, legacy);
}
export function requireProtocolWrite(handshake: ProtocolHandshake) {
  if (!handshake.write) throw Object.assign(Error(handshake.reason ?? "호환되지 않는 호스트에는 쓸 수 없습니다."), { status: 409, code: "protocol_incompatible" });
}
