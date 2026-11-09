/** What a component icon receives from the surface that draws it. */
export interface PluginIconProps {
    size: number;
    color: string;
}
/** Inline SVG markup. Paseo validates it when the contribution registers. */
export interface PluginSvgIcon {
    svg: string;
}
/** An icon that can be stored or sent: a Lucide icon name, or inline SVG. */
export type PluginSerializableIcon = string | PluginSvgIcon;
export declare const PLUGIN_SVG_ICON_MAX_BYTES: number;
/**
 * Why Paseo refuses to render this SVG, or null when it is a self-contained document.
 * The daemon applies it to provider and usage-source icon files; the app to inline plugin icons.
 */
export declare function findSvgIconProblem(svg: string): string | null;
