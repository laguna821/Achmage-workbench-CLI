export const PLUGIN_SVG_ICON_MAX_BYTES = 64 * 1024;
const EXTERNAL_HREF = /\s(?:href|xlink:href)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi;
/**
 * Why Paseo refuses to render this SVG, or null when it is a self-contained document.
 * The daemon applies it to provider and usage-source icon files; the app to inline plugin icons.
 */
export function findSvgIconProblem(svg) {
    if (new TextEncoder().encode(svg).byteLength > PLUGIN_SVG_ICON_MAX_BYTES) {
        return "exceeds 64 KiB";
    }
    if (!/^\s*<svg(?:\s|>)/i.test(svg))
        return "not an SVG document";
    if (/<script(?:\s|>)/i.test(svg))
        return "script elements are not allowed";
    if (/<foreignObject(?:\s|>)/i.test(svg))
        return "foreignObject elements are not allowed";
    if (/<style(?:\s|>)/i.test(svg))
        return "style elements are not allowed";
    if (/\son[a-z0-9_-]*\s*=/i.test(svg))
        return "event-handler attributes are not allowed";
    if (/javascript\s*:/i.test(svg))
        return "javascript URLs are not allowed";
    for (const match of svg.matchAll(EXTERNAL_HREF)) {
        const href = match[2] ?? match[3] ?? "";
        if (!href.startsWith("#"))
            return "external href references are not allowed";
    }
    return null;
}
