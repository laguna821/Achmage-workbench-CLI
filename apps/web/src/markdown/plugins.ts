import type { PluggableList } from "unified";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import remarkGfm from "remark-gfm";

/** Remark plugins every markdown surface shares. The strikethrough companion must come after remark-gfm (its own ~~ rule wins otherwise); remark-cjk-friendly's position does not matter. */
export const REMARK_BASE: PluggableList = [remarkGfm, remarkCjkFriendly, remarkCjkStrikethrough];
