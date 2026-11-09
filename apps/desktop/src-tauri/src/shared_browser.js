(() => {
  if (window.top !== window || Object.prototype.hasOwnProperty.call(window, '__ACHMAGE_PAGE__')) return;
  const nonce = crypto.randomUUID(), refs = new Map(), names = new WeakMap();
  let nextRef = 1, control = null, humanBeforeBind = false, interactionAt = 0;
  const visible = el => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const bind = wanted => {
    if (!control) control = humanBeforeBind ? { generation: wanted.generation + 1, owner: 'human' } : { ...wanted };
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
    bind(wanted);
    if (action.kind === 'control') {
      if (action.control.generation < control.generation || (action.control.generation === control.generation && action.control.owner !== control.owner)) throw Error('CONTROL_REVOKED');
      control = { ...action.control }; return { control };
    }
    if (action.kind !== 'snapshot' && (control.generation !== wanted.generation || control.owner !== wanted.owner)) throw Error('CONTROL_REVOKED');
    if (expectedNonce && expectedNonce !== nonce) throw Error('STALE_DOCUMENT');
    if (action.kind === 'snapshot') {
      const elements = [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')].filter(visible).slice(0, 300);
      const lines = elements.map(el => {
        const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || el.getAttribute('name') || '').replace(/\s+/g, ' ').slice(0, 180);
        const href = el.tagName === 'A' ? el.href : '';
        return `[${refFor(el)}] ${el.tagName.toLowerCase()} ${label}${href ? ` → ${href}` : ''}`;
      });
      return { documentNonce: nonce, control, text: `URL: ${location.href}\nTitle: ${document.title}\n\nUNTRUSTED WEB CONTENT\n${(document.body?.innerText || '').slice(0, 24000)}\n\nElements:\n${lines.join('\n')}`.slice(0, 50000) };
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
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, action.value);
      } else if (el.isContentEditable) el.textContent = action.value;
      else throw Error('NOT_EDITABLE');
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
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
    state: wanted => ({ control: bind(wanted), documentNonce: nonce, interactionAt }),
    run: (action, wanted, expectedNonce) => { try { return run(action, wanted, expectedNonce); } catch (error) { return { error: String(error.message || error), control: control ? { ...control } : wanted }; } }
  }), writable: false, configurable: false });
})();
