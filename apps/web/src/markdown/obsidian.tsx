import type { Element, ElementContent, Root as HastRoot, Text as HastText } from "hast";
import type { PhrasingContent, Root as MdastRoot } from "mdast";
import { findAndReplace } from "mdast-util-find-and-replace";
import type { CSSProperties, ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Icon, type IconName } from "../components/Icon.tsx";
import "../styles/markdown.css";

// Markdown as Obsidian shows it, for vault notes and the work's documents (not the conversation):
// callouts (`> [!NOTE] 제목`, folding with +/-), `==highlights==`, `#tags` in the text, hidden
// `^block-ids`, and the HTML notes carry (`<img width>`, `<details>`), cleaned of anything that
// could run (scripts, event handlers, javascript: links) before it is drawn.

type Plugins = NonNullable<Options["remarkPlugins"]>;

/** Obsidian's callout kinds and their aliases; any other kind looks like a note but keeps its name. */
const CALLOUT_KIND: Record<string, string> = {
  note: "note",
  abstract: "abstract",
  summary: "abstract",
  tldr: "abstract",
  info: "info",
  todo: "todo",
  tip: "tip",
  hint: "tip",
  important: "tip",
  success: "success",
  check: "success",
  done: "success",
  question: "question",
  help: "question",
  faq: "question",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  failure: "failure",
  fail: "failure",
  missing: "failure",
  danger: "danger",
  error: "danger",
  bug: "bug",
  example: "example",
  quote: "quote",
  cite: "quote",
};

const CALLOUT_ICON: Record<string, IconName> = {
  note: "edit",
  abstract: "clipboard",
  info: "info",
  todo: "check",
  tip: "flame",
  success: "check",
  question: "help",
  warning: "alert",
  failure: "x",
  danger: "bolt",
  bug: "bug",
  example: "list",
  quote: "quote",
};

export const calloutKind = (type: string) => CALLOUT_KIND[type] ?? "note";

// ── remark: highlights, tags, block ids ──────────────────────────────────────────────────────

/** `==text==` → mark, `#tag` → a tag, ` ^block-id` at a line's end → gone (Obsidian hides it). */
export function remarkObsidian() {
  return (tree: MdastRoot) => {
    findAndReplace(
      tree,
      [
        [/==(?=\S)([^=\n]*?\S)==/g, (_all: string, text: string) => ({ type: "emphasis", data: { hName: "mark" }, children: [{ type: "text", value: text }] }) as PhrasingContent],
        [
          // Letters, digits, _ - / with at least one non-digit, after a space or an opening mark (not "C#").
          /(^|[\s([{"'“‘（「『])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu,
          (_all: string, before: string, tag: string) =>
            [
              ...(before ? [{ type: "text", value: before }] : []),
              { type: "emphasis", data: { hName: "span", hProperties: { className: ["md-tag"], dataTag: tag } }, children: [{ type: "text", value: `#${tag}` }] },
            ] as PhrasingContent[],
        ],
        [/[ \t]\^[A-Za-z0-9-]+(?=\n|$)/g, ""],
      ],
      { ignore: ["link", "linkReference", "inlineCode", "code"] },
    );
  };
}

// ── rehype: callouts and embedded notes (after the HTML is cleaned) ───────────────────────────

const isText = (node: ElementContent | undefined): node is HastText => node?.type === "text";
const isElement = (node: ElementContent | undefined, tag?: string): node is Element => node?.type === "element" && (!tag || node.tagName === tag);
const blank = (node: ElementContent) => isText(node) && !node.value.trim();
const text = (value: string): HastText => ({ type: "text", value });
const element = (tagName: string, properties: Element["properties"], children: ElementContent[]): Element => ({ type: "element", tagName, properties, children });

const CALLOUT_HEAD = /^\s*\[!([^\]\n]+)\]([+-]?)[ \t]*/;

/**
 * A blockquote whose first line is `[!kind]±? title` as a callout: the title line (its inline
 * marks kept), then the rest. "+" folds open, "-" folds shut; no title shows the kind's name.
 */
export function toCallout(quote: Element): Element | null {
  const first = quote.children.find((child) => !blank(child));
  if (!isElement(first, "p")) return null;
  const lead = first.children[0];
  const head = isText(lead) ? CALLOUT_HEAD.exec(lead.value) : null;
  if (!head || !isText(lead)) return null;
  const type = head[1]!.trim().toLowerCase();
  const fold = head[2] ?? "";
  const kind = calloutKind(type);

  // The first line of the paragraph is the title, what follows a line break is content.
  const title: ElementContent[] = [];
  const rest: ElementContent[] = [];
  let inTitle = true;
  first.children.forEach((child, index) => {
    const node = index === 0 && isText(child) ? text(child.value.slice(head[0].length)) : child;
    if (!inTitle) return void rest.push(node);
    if (isElement(node, "br")) return void (inTitle = false);
    if (isText(node) && node.value.includes("\n")) {
      const cut = node.value.indexOf("\n");
      if (node.value.slice(0, cut)) title.push(text(node.value.slice(0, cut)));
      const after = node.value.slice(cut + 1);
      if (after) rest.push(text(after));
      inTitle = false;
      return;
    }
    title.push(node);
  });
  const titled = title.some((node) => !isText(node) || node.value.trim());
  const content: ElementContent[] = [];
  if (rest.some((node) => !blank(node))) content.push(element("p", {}, rest));
  const after = quote.children.slice(quote.children.indexOf(first) + 1).filter((child) => !blank(child));
  content.push(...after);

  const heading = element(fold ? "summary" : "div", { className: ["callout-title"] }, [
    element("span", { className: ["callout-icon"], dataKind: kind }, []),
    element("span", { className: ["callout-title-inner"] }, titled ? title : [text(type.charAt(0).toUpperCase() + type.slice(1))]),
  ]);
  return element(fold ? "details" : "div", { className: ["callout"], dataCallout: type, dataKind: kind, ...(fold === "+" ? { open: true } : {}) }, [
    heading,
    ...(content.length ? [element("div", { className: ["callout-content"] }, content)] : []),
  ]);
}

/** A paragraph holding only `[이름](vault-embed:경로#제목)` becomes the place the note is shown. */
function toEmbed(paragraph: Element): Element | null {
  const parts = paragraph.children.filter((child) => !blank(child));
  const link = parts[0];
  if (parts.length !== 1 || !isElement(link, "a")) return null;
  const href = String(link.properties.href ?? "");
  if (!href.startsWith("vault-embed:")) return null;
  const [path, heading] = href.slice("vault-embed:".length).split("#");
  return element("div", { className: ["note-embed"], dataPath: decodeURIComponent(path ?? ""), dataHeading: heading ? decodeURIComponent(heading) : "" }, link.children);
}

/** Children first, so a callout inside a callout is made before the outer one. */
function transform(parent: HastRoot | Element) {
  parent.children.forEach((child, index) => {
    if (child.type !== "element") return;
    transform(child);
    const next = child.tagName === "blockquote" ? toCallout(child) : child.tagName === "p" ? toEmbed(child) : null;
    if (next) parent.children[index] = next;
  });
}

export function rehypeObsidian() {
  return (tree: HastRoot) => transform(tree);
}

// ── what HTML may stay ─────────────────────────────────────────────────────────────────────

const allowed = defaultSchema.attributes ?? {};
export const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "u", "small", "abbr", "cite", "figure", "figcaption", "caption", "colgroup", "col", "center"],
  attributes: {
    ...allowed,
    span: [...(allowed.span ?? []), ["className", "md-tag"], "dataTag"],
  },
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), "vault-note", "vault-embed", "workbench"] },
  // Gone with what is inside them: what runs, styles the app, or is a page's head.
  strip: ["script", "style", "title", "template", "noscript", "iframe", "object", "embed", "textarea", "select"],
};

export const OBSIDIAN_REMARK: Plugins = [remarkGfm, remarkObsidian];
export const OBSIDIAN_REHYPE: Plugins = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeObsidian];

export const obsidianUrlTransform = (url: string) => (/^(vault-note|vault-embed):/.test(url) ? url : defaultUrlTransform(url));

// ── how the pieces are drawn ───────────────────────────────────────────────────────────────

/** An Obsidian size after `|` in a picture's text (`그림|300`, `|300x200`), or the HTML's own. */
export function pictureSize(alt: string, width?: string | number, height?: string | number) {
  const sized = /^(.*?)\|\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(alt);
  const number = (value: string | number | undefined) => (value === undefined || value === "" ? undefined : Number(value) || undefined);
  return {
    alt: sized ? sized[1]!.trim() : alt,
    width: number(width) ?? (sized ? Number(sized[2]) : undefined),
    height: number(height) ?? (sized?.[3] ? Number(sized[3]) : undefined),
  };
}

export type EmbedProps = { path: string; heading: string | null; label: ReactNode };

/**
 * Components for the Obsidian pieces, around the caller's own (pictures, links, diagrams).
 * `tagColor` gives a tag its Notebook Navigator colour; `embed` draws `![[note]]` (a link without it).
 */
export function obsidianComponents(base: Components, options: { tagColor?: (tag: string) => string | null; embed?: (props: EmbedProps) => ReactNode } = {}): Components {
  const Link = base.a;
  return {
    ...base,
    span: (props) => {
      const { node, className, children, ...rest } = props;
      if (className === "callout-icon") {
        const kind = String(node?.properties.dataKind ?? "note");
        return (
          <span className="callout-icon" aria-hidden>
            <Icon name={CALLOUT_ICON[kind] ?? "edit"} size={16} />
          </span>
        );
      }
      if (className === "md-tag") {
        const color = options.tagColor?.(String(node?.properties.dataTag ?? ""));
        return (
          <span className="md-tag" style={color ? ({ "--tag-color": color } as CSSProperties) : undefined}>
            {children}
          </span>
        );
      }
      return (
        <span className={className} {...rest}>
          {children}
        </span>
      );
    },
    div: (props) => {
      const { node, className, children, ...rest } = props;
      if (className === "note-embed") {
        const path = String(node?.properties.dataPath ?? "");
        const heading = String(node?.properties.dataHeading ?? "") || null;
        return options.embed ? <>{options.embed({ path, heading, label: children })}</> : <div className="note-embed">{children}</div>;
      }
      return (
        <div className={className} {...rest}>
          {children}
        </div>
      );
    },
    a: (props) => {
      const href = props.href ?? "";
      // Footnotes: the ids were made safe with a prefix, so the jump looks for that one.
      if (href.startsWith("#")) {
        const { node, children, ...rest } = props;
        void node;
        return (
          <a
            {...rest}
            onClick={(event) => {
              event.preventDefault();
              const id = decodeURIComponent(href.slice(1));
              const scope = event.currentTarget.closest(".markdown") ?? document;
              const target = scope.querySelector(`[id="user-content-${CSS.escape(id)}"]`) ?? scope.querySelector(`[id="${CSS.escape(id)}"]`);
              target?.scrollIntoView({ block: "center", behavior: "smooth" });
            }}
          >
            {children}
          </a>
        );
      }
      if (Link && typeof Link !== "string") return <Link {...props} />;
      const { node, children, ...rest } = props;
      void node;
      return (
        <a {...rest} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  };
}

/** Markdown with the Obsidian pieces; `components` should come from {@link obsidianComponents}. */
export function ObsidianMarkdown({ children, components, urlTransform = obsidianUrlTransform }: { children: string; components: Components; urlTransform?: Options["urlTransform"] }) {
  return (
    <Markdown remarkPlugins={OBSIDIAN_REMARK} rehypePlugins={OBSIDIAN_REHYPE} remarkRehypeOptions={{ clobberPrefix: "" }} components={components} urlTransform={urlTransform}>
      {children}
    </Markdown>
  );
}
