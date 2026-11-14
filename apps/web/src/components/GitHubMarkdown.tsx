import Markdown from "react-markdown";
import { REMARK_BASE } from "../markdown/plugins.ts";

/** Hosted text may contain arbitrary HTML or remote image URLs. Render Markdown without loading them. */
export function GitHubMarkdown({ children, className = "" }: { children: string; className?: string }) {
  return <div className={`markdown scm-gh-markdown ${className}`}><Markdown remarkPlugins={REMARK_BASE} components={{ img: ({ alt }) => <span>{alt ?? "이미지"}</span>, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{children}</Markdown></div>;
}
