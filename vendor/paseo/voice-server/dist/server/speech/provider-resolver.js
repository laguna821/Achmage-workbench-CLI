export function toResolver(value) {
    if (typeof value === "function") {
        return value;
    }
    return () => value;
}
