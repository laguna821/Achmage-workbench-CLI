import type { Artifact } from "@workbench/contracts";
import type { Documents } from "./artifacts.ts";
export function singleHtml(documents: Documents, artifact: Artifact, html: string): Promise<{ html: string; inlined: number; skipped: string[]; defaultName: string }>;
