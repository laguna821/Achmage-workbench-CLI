/**
 * What the browser says about the platform. `getShortcutOs()` is the app's
 * answer for keyboard policy and consults native and Electron first; this is the
 * browser half of it, kept free of React Native imports so the terminal WebView
 * bundle can use it too.
 */
export declare function isMacUserAgent(): boolean;
