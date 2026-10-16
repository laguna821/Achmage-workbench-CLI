// Adaptive titles without any model call. A session (or work) title follows what keeps coming
// back across the requests, not only the first one: words and phrases that recur across turns
// score high, the title is rebuilt from the sentence that best covers them, and it only changes
// when a new theme clearly wins, so it does not flicker.

const JOSA = [
  "에서부터", "으로부터", "이라고는", "에서는", "에게서", "으로는", "으로도", "이라고", "이라는", "에서도",
  "라고", "라는", "에서", "에게", "한테", "부터", "까지", "처럼", "보다", "으로", "이나", "이랑", "랑",
  "과", "와", "의", "은", "는", "이", "가", "을", "를", "에", "로", "도", "만", "요",
];

/** Nouns that end in a josa-looking syllable. */
const KEEP_WORDS = new Set(["어린이", "고양이", "원숭이", "민주주의", "자본주의", "사회주의", "회의", "강의", "논의", "정의", "합의", "토의", "동의", "건의", "질의", "문의", "의의", "평가", "결과", "효과", "과제", "참가", "추가", "국가", "작가", "전문가", "단가", "학과", "교과", "부가", "대가", "정도", "지도", "제도", "속도", "의도", "온도", "태도", "자료", "경로", "통로", "도로", "진로", "기록", "수요", "필요", "중요", "개요", "요요", "주요", "아이", "차이", "사이", "나이", "높이", "길이", "깊이", "놀이", "바이", "이미지", "레이아웃"]);

const STOP = new Set([
  // Korean fillers, pronouns, connectives
  "이거", "그거", "저거", "이것", "그것", "저것", "여기", "거기", "저기", "지금", "이제", "다시", "그리고", "그런데", "근데", "그래서",
  "그러면", "그럼", "하지만", "또한", "좀", "더", "잘", "많이", "너무", "정말", "진짜", "그냥", "일단", "혹시", "아마", "우리", "나", "내",
  "너", "네가", "제가", "저", "이런", "그런", "저런", "어떤", "무슨", "뭐", "왜", "어떻게", "같이", "하나", "것", "수", "때", "등", "및",
  "또", "또는", "위", "아래", "경우", "부분", "내용", "정도로", "생각", "방법", "방식", "느낌", "이번", "다음", "먼저", "모두", "전부", "각각",
  "같은", "있는", "없는", "되는", "하는", "해서", "하고", "하면", "해도", "있어", "없어", "있게", "없이", "보고", "봐", "줘", "말고", "대해",
  "관련", "위해", "통해", "따라", "기준", "때문", "이상", "이하", "정리된", "만든", "만들어진", "한번", "두번", "계속", "바로", "현재",
  "실제", "실제로", "자동으로", "확인", "부탁", "요청", "답", "답변", "대답", "최근", "새로", "나만", "나만의", "모두다", "싹",
  "많", "좋", "높", "낮", "작", "크", "길", "짧", "같", "있", "없", "되", "하", "볼", "할", "갈", "올", "쓸", "줄", "알", "뭘", "걸", "건", "게", "거",
  "이렇게", "그렇게", "저렇게", "어떻게", "여러", "여러가지", "가지", "각자", "따로", "그대로", "아직", "벌써", "항상", "보통",
  // English
  "the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "with", "is", "are", "be", "this", "that", "it", "its", "i", "you", "we",
  "please", "can", "could", "would", "should", "make", "use", "run", "then", "just", "reply", "exactly", "only", "word", "single", "do",
  "does", "did", "what", "how", "why", "when", "where", "which", "about", "into", "from", "by", "as", "at", "me", "my", "your", "our",
  "now", "again", "also", "any", "some", "all", "very", "really", "will", "let", "lets", "let's", "say", "tell", "give", "get", "no", "not",
]);

/** Request endings: "정리해줘" → action noun "정리"; "세워보자" → dropped. */
const PREDICATE = /(?:해\s*줘|해\s*주세요|해\s*주라|해\s*봐|해\s*보자|해\s*보면|해\s*볼까|하자|해요|합시다|합니다|했어|했다|해야|하기|할까|하는|하면|해서|하고|한다|된다|되게|되도록|해|줘|봐|자|요)$/;
const VERB_ONLY = /(?:세워|만들어|써|알려|보여|찾아|읽어|올려|바꿔|고쳐|넣어|빼|띄워|돌려|켜|꺼|열어|닫아|보내|불러)(?:줘|주세요|봐|보자|볼까|라|요)?$|(?:하|되|있|없|같|싶|보|주|가|오|말|않|못)(?:다|고|게|지|면|니|아|어|요|자|라|네|죠|는데|어서|아서|으면|는지)$/;

const HANGUL = /[가-힣]/;

/** `word` is the matching key (lower case); `display` keeps the writer's casing ("APA", "Achmage"). */
type Token = { word: string; display: string; action: boolean };

const hasFinal = (syllable: string) => (syllable.charCodeAt(0) - 0xac00) % 28 !== 0;

function stripJosa(word: string) {
  if (KEEP_WORDS.has(word)) return word;
  for (const josa of JOSA) {
    if (!word.endsWith(josa)) continue;
    const stem = word.slice(0, -josa.length);
    // Latin or digits before a josa ("mcp로", "2주차의"): always a josa.
    if (stem && !HANGUL.test(stem.slice(-1))) return stem;
    if (!stem || KEEP_WORDS.has(stem + josa)) continue;
    // One-syllable nouns ("탭이", "앱을") only when the josa fits the syllable's final consonant.
    if (stem.length === 1 && !(/^[이을은]$/.test(josa) ? hasFinal(stem) : /^[가를는]$/.test(josa) ? !hasFinal(stem) : false)) continue;
    if (josa === "의" && /(?:주|회|강|논|정|합|토|동|건|질|문)$/.test(stem) && stem.length < 3) continue;
    return stem;
  }
  return word;
}

/** Content words of one sentence, in order. */
export function tokens(sentence: string): Token[] {
  const out: Token[] = [];
  for (const raw of sentence.split(/[\s,·/()[\]{}"'“”‘’`~!?.:;<>|*#=+\\]+/)) {
    let word = raw.trim().replace(/^[-_]+|[-_]+$/g, "");
    if (!word) continue;
    if (HANGUL.test(word)) {
      const predicate = PREDICATE.exec(word);
      if (predicate) {
        const stem = word.slice(0, predicate.index);
        // "정리해줘" carries an action noun; bare verbs ("세워보자") carry nothing.
        if (stem.length >= 2 && !VERB_ONLY.test(word) && /(?:해|하|한|할|했|줘|봐)/.test(predicate[0])) {
          const noun = stripJosa(stem);
          out.push({ word: noun.toLowerCase(), display: noun, action: true });
        }
        continue;
      }
      if (VERB_ONLY.test(word)) continue;
      word = stripJosa(word);
      if (word.length < 1 || (word.length === 1 && STOP.has(word))) continue;
      if (word.length === 1 && raw.trim().length === 1) continue;
    } else if (!/^[a-z0-9][a-z0-9.+_-]*$/i.test(word) || word.length < 3) {
      // Keep Latin words of 3+ letters and number-led Korean units handled above.
      if (!/^\d+(?:주차|차시|장|절|회|번|편|강)$/.test(word)) continue;
    } else if (STOP.has(word.toLowerCase())) {
      continue;
    }
    const key = word.toLowerCase();
    if (STOP.has(key) || /^\d+$/.test(key)) continue;
    out.push({ word: key, display: word, action: false });
  }
  return out;
}

export function sentences(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.?!。])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

type Stats = {
  coverage: Map<string, number>;
  count: Map<string, number>;
  /** Adjacent word pairs, by number of requests they appear in. */
  pairs: Map<string, number>;
  /** First spelling seen for each word. */
  display: Map<string, string>;
  turns: number;
  firstTurn: Set<string>;
  lastTurns: Set<string>;
};

function stats(turns: string[]): Stats {
  const coverage = new Map<string, number>();
  const count = new Map<string, number>();
  const pairs = new Map<string, number>();
  const display = new Map<string, string>();
  const firstTurn = new Set<string>();
  const lastTurns = new Set<string>();
  turns.forEach((turn, index) => {
    const seen = new Set<string>();
    const seenPairs = new Set<string>();
    for (const sentence of sentences(turn)) {
      const found = tokens(sentence);
      for (const token of found) if (!display.has(token.word)) display.set(token.word, token.display);
      const words = found.map((token) => token.word);
      words.forEach((word, position) => {
        count.set(word, (count.get(word) ?? 0) + 1);
        seen.add(word);
        if (position > 0) seenPairs.add(`${words[position - 1]} ${word}`);
      });
    }
    for (const pair of seenPairs) pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    for (const word of seen) {
      coverage.set(word, (coverage.get(word) ?? 0) + 1);
      if (index === 0) firstTurn.add(word);
      if (index >= turns.length - 3) lastTurns.add(word);
    }
  });
  return { coverage, count, pairs, display, turns: turns.length, firstTurn, lastTurns };
}

function wordScore(word: string, s: Stats) {
  const coverage = s.coverage.get(word) ?? 0;
  if (!coverage) return 0;
  // Running through many turns matters most; repetition inside one turn matters little.
  return coverage * 2 + Math.log1p(s.count.get(word) ?? 0) + (s.firstTurn.has(word) ? 0.6 : 0) + (s.lastTurns.has(word) ? 0.3 : 0);
}

const MAX_WORDS = 5;
const MAX_LENGTH = 24;

function render(words: string[], s: Stats) {
  const picked: string[] = [];
  for (const word of words) {
    const shown = s.display.get(word) ?? word;
    if (picked.includes(shown)) continue;
    const next = [...picked, shown].join(" ");
    if (picked.length >= MAX_WORDS || next.length > MAX_LENGTH) break;
    picked.push(shown);
  }
  return picked.join(" ");
}

/** Score of a title under the current statistics (mean word score, small bonus for fuller titles). */
export function titleScore(title: string, turns: string[]) {
  const s = stats(turns);
  const words = tokens(title).map((token) => token.word);
  if (!words.length) return 0;
  const total = words.reduce((sum, word) => sum + wordScore(word, s), 0);
  return total / words.length + Math.min(words.length, 4) * 0.25;
}

/** Best short title for a set of requests (oldest first). */
export function titleFor(turns: string[]): string | null {
  const texts = turns.filter((turn) => turn.trim());
  if (!texts.length) return null;
  const s = stats(texts);
  const ranked = [...s.coverage.keys()].sort((a, b) => wordScore(b, s) - wordScore(a, s));
  if (!ranked.length) return null;
  // Words that run through the conversation: seen in at least two requests.
  const core = ranked.filter((word) => (s.coverage.get(word) ?? 0) >= 2).slice(0, 4);

  if (core.length < 2) {
    // One theme so far: the opening request's main sentence, as content words.
    const opening = sentences(texts[0])
      .map((sentence) => tokens(sentence).map((token) => token.word))
      .find((words) => words.length >= 2);
    return render(opening ?? ranked, s) || null;
  }

  // The sentence that holds most of the core, keeping core words and their immediate neighbours
  // (so "미디어 리터러시" stays a phrase), in the sentence's own order.
  const coreSet = new Set(core);
  let best: { words: string[]; score: number } | null = null;
  for (const turn of texts) {
    for (const sentence of sentences(turn)) {
      const words = tokens(sentence).map((token) => token.word);
      const hits = words.filter((word) => coreSet.has(word));
      if (!hits.length) continue;
      // A neighbour stays only when the pair itself recurs ("미디어 리터러시" asked twice).
      const recurring = (a: string | undefined, b: string | undefined) => Boolean(a && b && (s.pairs.get(`${a} ${b}`) ?? 0) >= 2);
      const kept = words.filter(
        (word, index) => coreSet.has(word) || recurring(words[index - 1], word) || recurring(word, words[index + 1]),
      );
      const score = new Set(hits).size * 4 + hits.reduce((sum, word) => sum + wordScore(word, s), 0) / hits.length - kept.length * 0.15;
      if (!best || score > best.score) best = { words: kept, score };
    }
  }
  const covered = best ? new Set(best.words.filter((word) => coreSet.has(word))).size : 0;
  if (best && covered >= Math.min(2, core.length)) return render(best.words, s) || null;
  // No sentence carries the core together: name it by the core words in order of first use.
  const order = [...s.coverage.keys()];
  return render(core.sort((a, b) => order.indexOf(a) - order.indexOf(b)), s) || null;
}

/**
 * Next automatic title. Keeps the current one unless the new theme scores clearly higher, so a
 * passing topic does not rename the session.
 */
export function adaptTitle(turns: string[], current: string | null): string | null {
  const next = titleFor(turns);
  if (!next || !current || next === current) return next ?? current;
  const nextScore = titleScore(next, turns);
  const currentScore = titleScore(current, turns);
  return nextScore > currentScore * 1.3 + 0.2 ? next : current;
}
