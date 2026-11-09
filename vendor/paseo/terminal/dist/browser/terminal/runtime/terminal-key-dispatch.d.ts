import { type TerminalKeyInput } from "@getpaseo/protocol/terminal-key-input";
import type { TerminalInputModeState } from "@getpaseo/protocol/terminal-input-mode";
export interface TerminalKeyModifierState {
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
}
export declare const EMPTY_TERMINAL_KEY_MODIFIERS: TerminalKeyModifierState;
export declare const TERMINAL_VIRTUAL_KEY_BUTTONS: {
    readonly esc: {
        readonly id: "esc";
        readonly label: "Esc";
        readonly key: "Escape";
    };
    readonly tab: {
        readonly id: "tab";
        readonly label: "Tab";
        readonly key: "Tab";
    };
    readonly up: {
        readonly id: "up";
        readonly label: "↑";
        readonly key: "ArrowUp";
    };
    readonly down: {
        readonly id: "down";
        readonly label: "↓";
        readonly key: "ArrowDown";
    };
    readonly left: {
        readonly id: "left";
        readonly label: "←";
        readonly key: "ArrowLeft";
    };
    readonly right: {
        readonly id: "right";
        readonly label: "→";
        readonly key: "ArrowRight";
    };
    readonly enter: {
        readonly id: "enter";
        readonly label: "Enter";
        readonly key: "Enter";
    };
    readonly backspace: {
        readonly id: "backspace";
        readonly label: "⌫";
        readonly key: "Backspace";
    };
    readonly space: {
        readonly id: "space";
        readonly label: "Space";
        readonly key: " ";
    };
};
export declare function createTerminalKeyInput(input: {
    key: string;
    modifiers: TerminalKeyModifierState;
    meta?: boolean;
}): TerminalKeyInput;
export declare function dispatchTerminalKeyInput(input: {
    keyInput: TerminalKeyInput;
    inputMode: TerminalInputModeState;
    sendData: (data: string) => void;
}): void;
