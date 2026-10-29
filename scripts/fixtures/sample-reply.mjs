// A realistic turn for design screenshots ("견본" in a request): the stand-in engines show the
// steps a real engine takes (thinking, a plan, a command with output, a new file) and answer in the
// Markdown a real answer has (heading, list, table, inline and fenced code, a quote). No model.

export const SAMPLE_THINKING = "강의안의 구조와 평가 기준을 먼저 확인합니다. 사례 두 장은 내용이 겹쳐 한 장으로 합칠 수 있습니다.";

export const SAMPLE_PLAN = [
  { step: "강의안 구조 살펴보기", status: "completed" },
  { step: "슬라이드 순서 다시 짜기", status: "completed" },
  { step: "과제 안내 붙이기", status: "completed" },
];

export const SAMPLE_COMMAND = 'rg -n "루브릭" 강의안.md';
export const SAMPLE_OUTPUT = "12:## 평가 루브릭\n14:- 1단계: 질문을 세운다\n15:- 2단계: 근거를 붙인다\n16:- 3단계: 자기 말로 다시 쓴다\n";

export const SAMPLE_FILE = "슬라이드-구성.md";
export const SAMPLE_FILE_TEXT = "# 3주차 슬라이드 구성\n\n1. 질문으로 시작\n2. 사례 세 가지\n3. 과제 안내\n";

const FENCE = "```";

/** The answer, in paragraphs (streamed one after another). */
export const SAMPLE_REPLY = [
  "3주차 슬라이드 구성을 다시 짰습니다. 핵심은 **질문을 먼저 세우고, 사례로 내려가는 순서**입니다.\n\n",
  "## 바꾼 점\n\n",
  "1. 도입부를 질문 하나로 시작하게 바꿨습니다.\n2. 겹치던 사례 슬라이드 두 장을 한 장으로 합쳤습니다.\n3. 마지막 장에 과제 안내를 붙였습니다.\n\n",
  "| 장 | 내용 | 시간 |\n|---|---|---|\n| 1 | 질문: AI가 쓴 글은 누구의 글인가 | 5분 |\n| 2–4 | 사례 세 가지와 토론 | 20분 |\n| 5 | 과제 안내와 평가 기준 | 5분 |\n\n",
  "평가 기준은 `강의안.md`의 **루브릭 3단계**를 그대로 따랐습니다. 확인에 쓴 명령은 이렇습니다.\n\n",
  `${FENCE}bash\n${SAMPLE_COMMAND}\n${FENCE}\n\n`,
  "> 과제 마감을 한 주 늦출지는 아직 정하지 않았습니다. 정해 주시면 안내 문구를 고치겠습니다.\n",
];
