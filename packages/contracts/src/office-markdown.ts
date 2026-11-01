export type OfficeMarkdownSnapshot = { revision: string; imageHost: Record<string, string> | null; markdownTheme: string; themeConfigured: boolean };
export type OfficeMarkdownRequest = { type: "office:markdown"; requestId: string; action: "read" | "host" | "theme"; value?: unknown; revision?: string };
export type OfficeMarkdownReply = { type: "office:markdown-result"; requestId: string; value?: OfficeMarkdownSnapshot; error?: string };
