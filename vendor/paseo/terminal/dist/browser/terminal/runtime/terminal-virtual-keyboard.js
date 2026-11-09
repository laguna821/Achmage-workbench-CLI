import { TERMINAL_VIRTUAL_KEY_BUTTONS, } from "./terminal-key-dispatch.js";
export const TERMINAL_VIRTUAL_KEYBOARD_ROWS = [
    [
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.esc },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.tab },
        { type: "modifier", modifier: "ctrl" },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.up },
        { type: "modifier", modifier: "shift" },
        { type: "keyboardToggle" },
    ],
    [
        { type: "modifier", modifier: "alt" },
        { type: "paste" },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.left },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.down },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.right },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.enter },
    ],
];
export const TERMINAL_VIRTUAL_KEYBOARD_WIDE_ROWS = [
    [
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.esc },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.tab },
        { type: "modifier", modifier: "ctrl" },
        { type: "modifier", modifier: "alt" },
        { type: "modifier", modifier: "shift" },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.left },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.down },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.up },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.right },
        { type: "paste" },
        { type: "keyboardToggle" },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.enter },
    ],
];
export const TERMINAL_VIRTUAL_KEYBOARD_THREE_COLUMN_ROWS = [
    [
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.esc },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.tab },
        { type: "modifier", modifier: "ctrl" },
    ],
    [
        { type: "modifier", modifier: "alt" },
        { type: "modifier", modifier: "shift" },
        { type: "keyboardToggle" },
    ],
    [
        { type: "paste" },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.up },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.enter },
    ],
    [
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.left },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.down },
        { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.right },
    ],
];
const TERMINAL_KEY_BAR_SINGLE_ROW_MIN_WIDTH = 660;
const TERMINAL_KEY_BAR_THREE_COLUMN_MAX_WIDTH = 300;
export function resolveTerminalVirtualKeyboardRows(input) {
    if (input.availableWidth > 0 && input.availableWidth < TERMINAL_KEY_BAR_THREE_COLUMN_MAX_WIDTH) {
        return TERMINAL_VIRTUAL_KEYBOARD_THREE_COLUMN_ROWS;
    }
    return !input.isCompact && input.availableWidth >= TERMINAL_KEY_BAR_SINGLE_ROW_MIN_WIDTH
        ? TERMINAL_VIRTUAL_KEYBOARD_WIDE_ROWS
        : TERMINAL_VIRTUAL_KEYBOARD_ROWS;
}
export function shouldShowTerminalVirtualKeyBar(input) {
    return input.isNative || input.isCompact;
}
export function getTerminalVirtualKeyboardControlId(control) {
    switch (control.type) {
        case "key":
            return `terminal-key-${control.button.id}`;
        case "modifier":
            return `terminal-key-${control.modifier}`;
        case "paste":
            return "terminal-paste";
        case "keyboardToggle":
            return "terminal-keyboard-toggle";
    }
}
export function shouldShowTerminalPasteAction(input) {
    return input.isNative;
}
export function shouldShowTerminalFloatingCopyAction(input) {
    return input.isNative && input.hasSelection;
}
