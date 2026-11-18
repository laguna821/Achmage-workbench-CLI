/**
 * The owner's decision for v0.13.0's AI settings (ieum-pin): Workbench's document AI runs on the person's
 * Claude Code / Codex login, so only those two cards stay in view. Everything else upstream offers (the
 * ChatGPT sign-in card, free AI, local AI, and the advanced keys / media panes with the new key
 * providers) moves, unchanged, into one fold "고급 · 다른 AI 연결", closed by default, under one plain line.
 * The AI-use choice and the first-connection notice stay where they were, under the two cards.
 */
export function foldOtherAiConnections(code: string): string {
  const fail = (): never => { throw new Error("Original AI settings section changed; review the 고급 · 다른 AI 연결 fold"); };
  const at = (marker: string) => {
    if (code.split(marker).length !== 2) fail();
    return code.indexOf(marker);
  };
  const cards = at('      <div className="set-sub-cards" ref={cardsRef}>\n');
  const free = at('      <h4 className="set-pane-subtitle set-sub-title free-ai-title" id="set-free-ai">\n');
  const use = at('      {settings && (\n        <>\n          <div className="set-field" data-ai-use="">\n');
  const advanced = at('      <button\n        type="button"\n        className="set-adv-toggle"\n');
  const endMarker = '          {advanced(tab, showCard)}\n        </>\n      )}\n';
  const end = at(endMarker + '    </>\n  )\n}\n') + endMarker.length;
  const list = "        {AI_SUBSCRIPTION_PROVIDERS.map((provider) => (\n";
  if (!(cards < free && free < use && use < advanced && advanced < end) || code.slice(cards, free).split(list).length !== 2) fail();
  const block = code.slice(cards, free);
  const ours = block.replace(list, "        {AI_SUBSCRIPTION_PROVIDERS.filter((provider) => provider === 'claude-code' || provider === 'codex').map((provider) => (\n");
  const others = block.replace(' ref={cardsRef}', '').replace(list, "        {AI_SUBSCRIPTION_PROVIDERS.filter((provider) => provider !== 'claude-code' && provider !== 'codex').map((provider) => (\n");
  const fold = `      <button type="button" className="set-adv-toggle wb-other-ai-toggle" aria-expanded={wbOtherOpen} onClick={() => setWbOtherOpen((open) => !open)}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        고급 · 다른 AI 연결
      </button>
      <div className="set-field-desc">Workbench의 문서 AI는 이 컴퓨터의 Claude Code나 Codex 로그인을 씁니다. 아래 연결은 쓰지 않아도 됩니다.</div>
      {wbOtherOpen && (
        <>
`;
  code = code.slice(0, cards) + ours + code.slice(use, advanced) + fold + others + code.slice(free, use) + code.slice(advanced, end) + "        </>\n      )}\n" + code.slice(end);
  const state = "  const [advancedOpen, setAdvancedOpen] = useState(openTab !== undefined)\n";
  at(state);
  return code.replace(state, state + "  const [wbOtherOpen, setWbOtherOpen] = useState(openTab !== undefined)\n");
}

