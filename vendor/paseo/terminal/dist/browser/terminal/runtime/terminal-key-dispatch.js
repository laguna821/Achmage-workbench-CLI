import { encodeTerminalKeyInput, } from "@getpaseo/protocol/terminal-key-input";
import { normalizeTerminalTransportKey } from "../../utils/terminal-keys.js";
export const EMPTY_TERMINAL_KEY_MODIFIERS = {
    ctrl: false,
    shift: false,
    alt: false,
};
export const TERMINAL_VIRTUAL_KEY_BUTTONS = {
    esc: { id: "esc", label: "Esc", key: "Escape" },
    tab: { id: "tab", label: "Tab", key: "Tab" },
    up: { id: "up", label: "↑", key: "ArrowUp" },
    down: { id: "down", label: "↓", key: "ArrowDown" },
    left: { id: "left", label: "←", key: "ArrowLeft" },
    right: { id: "right", label: "→", key: "ArrowRight" },
    enter: { id: "enter", label: "Enter", key: "Enter" },
    backspace: { id: "backspace", label: "⌫", key: "Backspace" },
    space: { id: "space", label: "Space", key: " " },
};
export function createTerminalKeyInput(input) {
    return {
        key: normalizeTerminalTransportKey(input.key),
        ctrl: input.modifiers.ctrl,
        shift: input.modifiers.shift,
        alt: input.modifiers.alt,
        meta: input.meta,
    };
}
export function dispatchTerminalKeyInput(input) {
    const encoded = encodeTerminalKeyInput(input.keyInput, { inputMode: input.inputMode });
    if (encoded.length > 0) {
        input.sendData(encoded);
    }
}
