(() => {
  if (window.top !== window || Object.prototype.hasOwnProperty.call(window, '__ACHMAGE_PAGE__')) return;
  // getRandomValues also works on HTTP intranet pages where randomUUID requires a secure context.
  const newNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const refs = new Map();
  let nonce = newNonce(), names = new WeakMap(), documentUrl = location.href;
  let nextRef = 1, control = null, humanBeforeBind = false, interactionAt = 0;
  const refreshDocument = () => {
    // History API navigation does not create a new webview/document. References from the
    // previous SPA route must still expire, and the native address bar must follow it.
    if (documentUrl !== location.href) {
      documentUrl = location.href; nonce = newNonce(); refs.clear(); names = new WeakMap(); nextRef = 1;
    }
  };
  const metadata = () => ({ url: location.href, title: document.title, documentNonce: nonce });
  const visible = el => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const bind = wanted => {
    if (!control) control = humanBeforeBind && wanted.owner !== 'human' ? { generation: wanted.generation + 1, owner: 'human' } : { ...wanted };
    return { ...control };
  };
  const human = event => {
    if (!event.isTrusted) return;
    interactionAt = Date.now();
    if (!control) humanBeforeBind = true;
    else if (control.owner !== 'human') control = { generation: control.generation + 1, owner: 'human' };
  };
  for (const name of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(name, human, { capture: true, passive: true });
  const refFor = el => {
    if (!names.has(el)) { const name = `e${nextRef++}`; names.set(el, name); refs.set(name, el); }
    return names.get(el);
  };
  const run = (action, wanted, expectedNonce) => {
    // A fresh chat grant supersedes interaction that happened before the initial
    // document binding. Once bound, later trusted input still fences queued work.
    if (action.kind === 'control' && !control) {
      control = { ...action.control }; humanBeforeBind = false; return { control };
    }
    bind(wanted);
    if (action.kind === 'control') {
      if (action.control.generation < control.generation || (action.control.generation === control.generation && action.control.owner !== control.owner)) throw Error('CONTROL_REVOKED');
      control = { ...action.control }; return { control };
    }
    if (!['snapshot', 'read'].includes(action.kind) && (control.generation !== wanted.generation || control.owner !== wanted.owner)) throw Error('CONTROL_REVOKED');
    if (expectedNonce && expectedNonce !== nonce) throw Error('STALE_DOCUMENT');
    if (action.kind === 'read') {
      if (!Number.isSafeInteger(action.offset) || action.offset < 0 || action.offset > 10000000 || !Number.isSafeInteger(action.limit) || action.limit < 1 || action.limit > 24000) throw Error('INVALID_READ_RANGE: read [offset] [limit], limit 1..24000');
      const body = document.body?.innerText || '', start = Math.min(action.offset, body.length), end = Math.min(start + action.limit, body.length);
      const continuation = end < body.length ? `Next: playwright-cli read ${end} ${action.limit}` : 'End of rendered page text.';
      return { control, text: `URL: ${location.href}\nTitle: ${document.title}\nCharacters: ${start}-${end} of ${body.length} (end exclusive)\n${continuation}\n\nUNTRUSTED WEB CONTENT\n${body.slice(start, end)}` };
    }
    if (action.kind === 'snapshot') {
      const elements = [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')].filter(visible).slice(0, 300);
      const lines = elements.map(el => {
        const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || el.getAttribute('name') || '').replace(/\s+/g, ' ').slice(0, 180);
        const href = el.tagName === 'A' ? el.href : '';
        const editable = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['password', 'file', 'hidden'].includes(el.type)) || el instanceof HTMLSelectElement;
        const value = editable ? ` value=${JSON.stringify(el.value.slice(0, 500))}` : '';
        return `[${refFor(el)}] ${el.tagName.toLowerCase()} ${label}${href ? ` → ${href}` : ''}${value}`;
      });
      const body = document.body?.innerText || '';
      const overview = body.length > 24000 ? `Overview truncated: 24000 of ${body.length} characters. Use playwright-cli read 24000 12000 for more rendered text.\n` : '';
      return { control, text: `URL: ${location.href}\nTitle: ${document.title}\n${overview}\nUNTRUSTED WEB CONTENT\n${body.slice(0, 24000)}\n\nElements:\n${lines.join('\n')}`.slice(0, 50000) };
    }
    if (action.kind === 'scroll') { window.scrollBy(action.x, action.y); return { control }; }
    if (['navigate', 'back', 'forward', 'reload', 'stop', 'close'].includes(action.kind)) return { control };
    const el = refs.get(action.ref);
    if (!el || !visible(el)) throw Error('STALE_ELEMENT: snapshot을 다시 읽어 주세요.');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw Error('DISABLED_ELEMENT');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (action.kind === 'click') el.click();
    else if (action.kind === 'fill') {
      el.focus();
      if (el instanceof HTMLInputElement && ['file', 'password'].includes(el.type)) throw Error('PROTECTED_INPUT: 이 입력은 사람이 직접 처리해 주세요.');
      if (el.readOnly) throw Error('READ_ONLY_INPUT');
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, action.value);
      } else if (el.isContentEditable) el.textContent = action.value;
      else throw Error('NOT_EDITABLE');
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      const actual = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent;
      if (actual !== action.value) throw Error('INPUT_NOT_APPLIED: 입력 내용이 페이지에 반영되지 않았습니다.');
    } else if (action.kind === 'select') {
      if (!(el instanceof HTMLSelectElement) || ![...el.options].some(option => option.value === action.value)) throw Error('OPTION_NOT_FOUND');
      el.value = action.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (action.kind === 'press') {
      el.focus();
      const accepted = el.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true, cancelable: true }));
      if (accepted && action.key === 'Enter') {
        if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement) el.click();
        else if (el.form) el.form.requestSubmit();
      } else if (accepted && action.key === 'Escape') el.blur();
      else if (accepted && action.key === 'Tab') {
        const focusable = [...document.querySelectorAll('a[href],button,input,textarea,select,[tabindex]')].filter(node => visible(node) && !node.disabled && node.tabIndex >= 0);
        const index = focusable.indexOf(el); focusable[(index + 1) % focusable.length]?.focus();
      }
      el.dispatchEvent(new KeyboardEvent('keyup', { key: action.key, bubbles: true }));
    } else throw Error('UNSUPPORTED_ACTION');
    return { control };
  };
  Object.defineProperty(window, '__ACHMAGE_PAGE__', { value: Object.freeze({
    state: wanted => { refreshDocument(); return { control: bind(wanted), interactionAt, ...metadata() }; },
    run: (action, wanted, expectedNonce) => {
      refreshDocument();
      try { const result = run(action, wanted, expectedNonce); refreshDocument(); return { ...result, ...metadata() }; }
      catch (error) { return { error: String(error.message || error), control: control ? { ...control } : wanted, ...metadata() }; }
    }
  }), writable: false, configurable: false });
})();
