export interface PendingTerminalModifiers {
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
}
export declare function isTerminalModifierDomKey(rawKey: string): boolean;
export declare function normalizeDomTerminalKey(rawKey: string): string | null;
export declare function normalizeTerminalTransportKey(key: string): string;
export declare function hasPendingTerminalModifiers(modifiers: PendingTerminalModifiers): boolean;
interface AppleHandheldDetectionInput {
    userAgent: string | null | undefined;
    platform: string | null | undefined;
    maxTouchPoints: number | null | undefined;
}
export declare function isAppleHandheldPlatform(input: AppleHandheldDetectionInput): boolean;
export declare function shouldInterceptDomTerminalKey(args: {
    key: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    pendingModifiers: PendingTerminalModifiers;
    enhancedInputActive?: boolean;
    isAppleHandheld?: boolean;
}): boolean;
interface MacTerminalEditingShortcutInput {
    key: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
}
export declare function resolveMacTerminalEditingShortcut(args: MacTerminalEditingShortcutInput): string | null;
export declare function mergeTerminalModifiers(args: {
    pendingModifiers: PendingTerminalModifiers;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
}): {
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
};
export declare function mapTerminalDataToKey(data: string): string | null;
export declare function resolvePendingModifierDataInput(args: {
    data: string;
    pendingModifiers: PendingTerminalModifiers;
}): {
    mode: "key";
    key: string;
    clearPendingModifiers: true;
} | {
    mode: "raw";
    clearPendingModifiers: boolean;
};
export {};
