import { readFileSync } from "node:fs";
import type { ClientOptions } from "./index.ts";

/** A fixture supplies a real local test host's endpoint; it never simulates successful commands. */
export function connection(fixture?: string): ClientOptions {
  const raw = fixture ? JSON.parse(readFileSync(fixture, "utf8")) as { baseUrl: string; token: string } : null;
  const baseUrl = raw?.baseUrl ?? process.env.WORKBENCH_URL;
  if (!baseUrl) throw Error("WORKBENCH_URL에 실행 중인 Workbench 호스트 주소를 지정해 주세요.");
  return { baseUrl, token: raw?.token ?? process.env.WORKBENCH_TOKEN ?? "" };
}
