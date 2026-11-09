/*
 * Adapted from MIT-licensed upstream terminal link parsing.
 * Copyright (c) Microsoft Corporation.
 */
const linkSuffixRegexEol = generateLinkSuffixRegex(true);
const linkSuffixRegex = generateLinkSuffixRegex(false);
function generateLinkSuffixRegex(eolOnly) {
    let rowIndex = 0;
    let colIndex = 0;
    let rowEndIndex = 0;
    let colEndIndex = 0;
    const row = () => `(?<row${rowIndex++}>\\d+)`;
    const col = () => `(?<col${colIndex++}>\\d+)`;
    const rowEnd = () => `(?<rowEnd${rowEndIndex++}>\\d+)`;
    const colEnd = () => `(?<colEnd${colEndIndex++}>\\d+)`;
    const eolSuffix = eolOnly ? "$" : "";
    const clauses = [
        `(?::|#| |['"],|, )${row()}([:.]${col()}(?:-(?:${rowEnd()}\\.)?${colEnd()})?)?${eolSuffix}`,
        `['"]?(?:,? |: ?| on )lines? ${row()}(?:-${rowEnd()})?(?:,? (?:col(?:umn)?|characters?) ${col()}(?:-${colEnd()})?)?${eolSuffix}`,
        `:? ?[\\[\\(]${row()}(?:(?:, ?|:)${col()})?[\\]\\)]${eolSuffix}`,
    ];
    return new RegExp(`(${clauses.join("|").replace(/ /g, "[\u00A0 ]")})`, eolOnly ? undefined : "g");
}
export function getTerminalLinkSuffix(link) {
    return toLinkSuffix(linkSuffixRegexEol.exec(link));
}
function detectLinkSuffixes(line) {
    const results = [];
    linkSuffixRegex.lastIndex = 0;
    let match;
    while ((match = linkSuffixRegex.exec(line)) !== null) {
        const suffix = toLinkSuffix(match);
        if (!suffix) {
            break;
        }
        results.push(suffix);
    }
    return results;
}
function toLinkSuffix(match) {
    const groups = match?.groups;
    if (!groups || match.length < 1) {
        return null;
    }
    return {
        row: parseIntOptional(groups.row0 || groups.row1 || groups.row2),
        col: parseIntOptional(groups.col0 || groups.col1 || groups.col2),
        rowEnd: parseIntOptional(groups.rowEnd0 || groups.rowEnd1 || groups.rowEnd2),
        colEnd: parseIntOptional(groups.colEnd0 || groups.colEnd1 || groups.colEnd2),
        suffix: { index: match.index, text: match[0] },
    };
}
function parseIntOptional(value) {
    return value === undefined ? undefined : parseInt(value, 10);
}
const linkWithSuffixPathCharacters = /(?<path>(?:file:\/\/\/)?[^\s|<>[({][^\s|<>]*)$/;
const unixLocalLinkClause = `(?:(?:${"(?:\\.\\.?|\\~|file:\\/\\/)" /* RegexPathConstants.PathPrefix */}|(?:${"[^\\0<>\\?\\s!`&*()\\[\\]'\":;\\\\]" /* RegexPathConstants.ExcludedStartPathCharactersClause */}${"[^\\0<>\\?\\s!`&*()'\":;\\\\]" /* RegexPathConstants.ExcludedPathCharactersClause */}*))?(?:${"\\/" /* RegexPathConstants.PathSeparatorClause */}(?:${"[^\\0<>\\?\\s!`&*()'\":;\\\\]" /* RegexPathConstants.ExcludedPathCharactersClause */})+)+)`;
const winDrivePrefix = "(?:\\\\\\\\\\?\\\\|file:\\/\\/\\/)?[a-zA-Z]:";
const winLocalLinkClause = `(?:(?:(?:${winDrivePrefix}|${"\\.\\.?|\\~" /* RegexPathConstants.WinOtherPathPrefix */})|(?:${"[^\\0<>\\?\\|\\/\\s!`&*()\\[\\]'\":;]" /* RegexPathConstants.WinExcludedStartPathCharactersClause */}${"[^\\0<>\\?\\|\\/\\s!`&*()'\":;]" /* RegexPathConstants.WinExcludedPathCharactersClause */}*))?(?:${"(?:\\\\|\\/)" /* RegexPathConstants.WinPathSeparatorClause */}(?:${"[^\\0<>\\?\\|\\/\\s!`&*()'\":;]" /* RegexPathConstants.WinExcludedPathCharactersClause */})+)+)`;
export function detectTerminalLocalLinks(line) {
    const results = detectLinksViaSuffix(line);
    insertNonConflicting(results, detectPathsNoSuffix(line, unixLocalLinkClause));
    insertNonConflicting(results, detectPathsNoSuffix(line, winLocalLinkClause));
    return results;
}
function detectLinksViaSuffix(line) {
    const results = [];
    const suffixes = detectLinkSuffixes(line);
    for (const suffix of suffixes) {
        results.push(...detectLinksForSuffix(line, suffix));
    }
    return results;
}
function detectLinksForSuffix(line, suffix) {
    const beforeSuffix = line.substring(0, suffix.suffix.index);
    const possiblePathMatch = beforeSuffix.match(linkWithSuffixPathCharacters);
    if (!possiblePathMatch?.groups?.path || possiblePathMatch.index === undefined) {
        return [];
    }
    const pathWithPrefix = trimPathPrefix({
        path: possiblePathMatch.groups.path,
        startIndex: possiblePathMatch.index,
        suffix,
    });
    if (!pathWithPrefix) {
        return [];
    }
    const pathIndex = pathWithPrefix.startIndex + (pathWithPrefix.prefix?.text.length ?? 0);
    const links = [
        {
            path: {
                index: pathIndex,
                text: pathWithPrefix.path,
            },
            prefix: pathWithPrefix.prefix,
            suffix,
        },
    ];
    for (const match of pathWithPrefix.path.matchAll(/(?<bracket>[[(])/g)) {
        const bracket = match.groups?.bracket;
        if (!bracket) {
            continue;
        }
        const nextCharacter = pathWithPrefix.path[match.index + bracket.length];
        if (nextCharacter === "]" || nextCharacter === ")") {
            continue;
        }
        links.push({
            path: {
                index: pathIndex + match.index + 1,
                text: pathWithPrefix.path.substring(match.index + bracket.length),
            },
            prefix: pathWithPrefix.prefix,
            suffix,
        });
    }
    return links;
}
function trimPathPrefix(input) {
    const prefixMatch = input.path.match(/^(?<prefix>['"]+)/);
    if (!prefixMatch?.groups?.prefix) {
        return { path: input.path, startIndex: input.startIndex };
    }
    const prefix = {
        index: input.startIndex,
        text: prefixMatch.groups.prefix,
    };
    const path = input.path.substring(prefix.text.length);
    if (path.trim().length === 0) {
        return null;
    }
    const trimPrefixAmount = getTrimPrefixAmount(prefix.text, input.suffix);
    if (trimPrefixAmount === 0) {
        return { path, startIndex: input.startIndex, prefix };
    }
    prefix.index += trimPrefixAmount;
    prefix.text = prefix.text[prefix.text.length - 1] ?? prefix.text;
    return { path, startIndex: input.startIndex + trimPrefixAmount, prefix };
}
function getTrimPrefixAmount(prefixText, suffix) {
    const suffixQuote = suffix.suffix.text[0];
    if (prefixText.length > 1 &&
        suffixQuote?.match(/['"]/) &&
        prefixText[prefixText.length - 1] === suffixQuote) {
        return prefixText.length - 1;
    }
    return 0;
}
function detectPathsNoSuffix(line, clause) {
    const results = [];
    const regex = new RegExp(clause, "g");
    let match;
    while ((match = regex.exec(line)) !== null) {
        let text = match[0];
        let index = match.index;
        if (!text) {
            break;
        }
        if (((line.startsWith("--- a/") || line.startsWith("+++ b/")) && index === 4) ||
            (line.startsWith("diff --git") && (text.startsWith("a/") || text.startsWith("b/")))) {
            text = text.substring(2);
            index += 2;
        }
        results.push({
            path: { index, text },
            prefix: undefined,
            suffix: undefined,
        });
    }
    return results;
}
function insertNonConflicting(list, newItems) {
    for (const item of newItems) {
        const start = item.path.index;
        const end = item.path.index + item.path.text.length;
        const hasConflict = list.some((existing) => {
            const existingStart = existing.path.index;
            const existingEnd = existing.suffix?.suffix.index !== undefined
                ? existing.suffix.suffix.index + existing.suffix.suffix.text.length
                : existing.path.index + existing.path.text.length;
            return start < existingEnd && end > existingStart;
        });
        if (!hasConflict) {
            list.push(item);
        }
    }
    list.sort((left, right) => left.path.index - right.path.index);
}
