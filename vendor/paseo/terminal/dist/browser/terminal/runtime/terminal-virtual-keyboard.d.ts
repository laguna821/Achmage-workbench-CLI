import { TERMINAL_VIRTUAL_KEY_BUTTONS, type TerminalKeyModifierState } from "./terminal-key-dispatch.js";
type TerminalVirtualKeyButton = (typeof TERMINAL_VIRTUAL_KEY_BUTTONS)[keyof typeof TERMINAL_VIRTUAL_KEY_BUTTONS];
export type TerminalVirtualKeyboardControl = {
    type: "key";
    button: TerminalVirtualKeyButton;
} | {
    type: "modifier";
    modifier: keyof TerminalKeyModifierState;
} | {
    type: "paste";
} | {
    type: "keyboardToggle";
};
export declare const TERMINAL_VIRTUAL_KEYBOARD_ROWS: readonly [readonly [{
    readonly type: "key";
    readonly button: {
        readonly id: "esc";
        readonly label: "Esc";
        readonly key: "Escape";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "tab";
        readonly label: "Tab";
        readonly key: "Tab";
    };
}, {
    readonly type: "modifier";
    readonly modifier: "ctrl";
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "up";
        readonly label: "↑";
        readonly key: "ArrowUp";
    };
}, {
    readonly type: "modifier";
    readonly modifier: "shift";
}, {
    readonly type: "keyboardToggle";
}], readonly [{
    readonly type: "modifier";
    readonly modifier: "alt";
}, {
    readonly type: "paste";
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "left";
        readonly label: "←";
        readonly key: "ArrowLeft";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "down";
        readonly label: "↓";
        readonly key: "ArrowDown";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "right";
        readonly label: "→";
        readonly key: "ArrowRight";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "enter";
        readonly label: "Enter";
        readonly key: "Enter";
    };
}]];
export declare const TERMINAL_VIRTUAL_KEYBOARD_WIDE_ROWS: readonly [readonly [{
    readonly type: "key";
    readonly button: {
        readonly id: "esc";
        readonly label: "Esc";
        readonly key: "Escape";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "tab";
        readonly label: "Tab";
        readonly key: "Tab";
    };
}, {
    readonly type: "modifier";
    readonly modifier: "ctrl";
}, {
    readonly type: "modifier";
    readonly modifier: "alt";
}, {
    readonly type: "modifier";
    readonly modifier: "shift";
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "left";
        readonly label: "←";
        readonly key: "ArrowLeft";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "down";
        readonly label: "↓";
        readonly key: "ArrowDown";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "up";
        readonly label: "↑";
        readonly key: "ArrowUp";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "right";
        readonly label: "→";
        readonly key: "ArrowRight";
    };
}, {
    readonly type: "paste";
}, {
    readonly type: "keyboardToggle";
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "enter";
        readonly label: "Enter";
        readonly key: "Enter";
    };
}]];
export declare const TERMINAL_VIRTUAL_KEYBOARD_THREE_COLUMN_ROWS: readonly [readonly [{
    readonly type: "key";
    readonly button: {
        readonly id: "esc";
        readonly label: "Esc";
        readonly key: "Escape";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "tab";
        readonly label: "Tab";
        readonly key: "Tab";
    };
}, {
    readonly type: "modifier";
    readonly modifier: "ctrl";
}], readonly [{
    readonly type: "modifier";
    readonly modifier: "alt";
}, {
    readonly type: "modifier";
    readonly modifier: "shift";
}, {
    readonly type: "keyboardToggle";
}], readonly [{
    readonly type: "paste";
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "up";
        readonly label: "↑";
        readonly key: "ArrowUp";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "enter";
        readonly label: "Enter";
        readonly key: "Enter";
    };
}], readonly [{
    readonly type: "key";
    readonly button: {
        readonly id: "left";
        readonly label: "←";
        readonly key: "ArrowLeft";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "down";
        readonly label: "↓";
        readonly key: "ArrowDown";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "right";
        readonly label: "→";
        readonly key: "ArrowRight";
    };
}]];
export declare function resolveTerminalVirtualKeyboardRows(input: {
    isCompact: boolean;
    availableWidth: number;
}): readonly [readonly [{
    readonly type: "key";
    readonly button: {
        readonly id: "esc";
        readonly label: "Esc";
        readonly key: "Escape";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "tab";
        readonly label: "Tab";
        readonly key: "Tab";
    };
}, {
    readonly type: "modifier";
    readonly modifier: "ctrl";
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "up";
        readonly label: "↑";
        readonly key: "ArrowUp";
    };
}, {
    readonly type: "modifier";
    readonly modifier: "shift";
}, {
    readonly type: "keyboardToggle";
}], readonly [{
    readonly type: "modifier";
    readonly modifier: "alt";
}, {
    readonly type: "paste";
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "left";
        readonly label: "←";
        readonly key: "ArrowLeft";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "down";
        readonly label: "↓";
        readonly key: "ArrowDown";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "right";
        readonly label: "→";
        readonly key: "ArrowRight";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "enter";
        readonly label: "Enter";
        readonly key: "Enter";
    };
}]] | readonly [readonly [{
    readonly type: "key";
    readonly button: {
        readonly id: "esc";
        readonly label: "Esc";
        readonly key: "Escape";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "tab";
        readonly label: "Tab";
        readonly key: "Tab";
    };
}, {
    readonly type: "modifier";
    readonly modifier: "ctrl";
}, {
    readonly type: "modifier";
    readonly modifier: "alt";
}, {
    readonly type: "modifier";
    readonly modifier: "shift";
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "left";
        readonly label: "←";
        readonly key: "ArrowLeft";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "down";
        readonly label: "↓";
        readonly key: "ArrowDown";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "up";
        readonly label: "↑";
        readonly key: "ArrowUp";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "right";
        readonly label: "→";
        readonly key: "ArrowRight";
    };
}, {
    readonly type: "paste";
}, {
    readonly type: "keyboardToggle";
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "enter";
        readonly label: "Enter";
        readonly key: "Enter";
    };
}]] | readonly [readonly [{
    readonly type: "key";
    readonly button: {
        readonly id: "esc";
        readonly label: "Esc";
        readonly key: "Escape";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "tab";
        readonly label: "Tab";
        readonly key: "Tab";
    };
}, {
    readonly type: "modifier";
    readonly modifier: "ctrl";
}], readonly [{
    readonly type: "modifier";
    readonly modifier: "alt";
}, {
    readonly type: "modifier";
    readonly modifier: "shift";
}, {
    readonly type: "keyboardToggle";
}], readonly [{
    readonly type: "paste";
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "up";
        readonly label: "↑";
        readonly key: "ArrowUp";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "enter";
        readonly label: "Enter";
        readonly key: "Enter";
    };
}], readonly [{
    readonly type: "key";
    readonly button: {
        readonly id: "left";
        readonly label: "←";
        readonly key: "ArrowLeft";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "down";
        readonly label: "↓";
        readonly key: "ArrowDown";
    };
}, {
    readonly type: "key";
    readonly button: {
        readonly id: "right";
        readonly label: "→";
        readonly key: "ArrowRight";
    };
}]];
export declare function shouldShowTerminalVirtualKeyBar(input: {
    isNative: boolean;
    isCompact: boolean;
}): boolean;
export declare function getTerminalVirtualKeyboardControlId(control: TerminalVirtualKeyboardControl): string;
export declare function shouldShowTerminalPasteAction(input: {
    isNative: boolean;
}): boolean;
export declare function shouldShowTerminalFloatingCopyAction(input: {
    hasSelection: boolean;
    isNative: boolean;
}): boolean;
export {};
