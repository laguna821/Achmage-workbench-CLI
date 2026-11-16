/* Achmage Workbench product page — behaviour. No library. Every state it adds has a static fallback in the CSS. */
(() => {
  "use strict";
  const d = document, root = d.documentElement;
  const $ = (s, c = d) => c.querySelector(s), $$ = (s, c = d) => Array.from(c.querySelectorAll(s));
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const pinned = matchMedia("(min-width: 72rem) and (min-height: 45rem)");

  /* ── theme: stored choice, circular wipe from the pressed point where View Transitions exist ── */
  const toggles = $$(".theme-toggle");
  const themeNow = () => root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const paintToggles = () => {
    const dark = themeNow() === "dark", label = dark ? "밝은 화면으로 바꾸기" : "어두운 화면으로 바꾸기";
    toggles.forEach((t) => {
      if (t.classList.contains("theme-toggle--text")) t.textContent = label; else t.setAttribute("aria-label", label);
    });
  };
  paintToggles();
  toggles.forEach((t) => t.addEventListener("click", (e) => {
    const next = themeNow() === "dark" ? "light" : "dark";
    const apply = () => { root.dataset.theme = next; try { localStorage.setItem("achmage-theme", next); } catch (_) {} paintToggles(); };
    if (!d.startViewTransition || reduce.matches) return apply();
    const r = t.getBoundingClientRect();
    root.style.setProperty("--wipe-x", ((e.clientX || r.left + r.width / 2) / innerWidth * 100) + "%");
    root.style.setProperty("--wipe-y", ((e.clientY || r.top + r.height / 2) / innerHeight * 100) + "%");
    d.startViewTransition(apply);
  }));

  /* ── the section list on small screens: closes on a choice, on Escape and on a press outside ── */
  const menu = $(".menu");
  if (menu) {
    const close = (focus) => { if (!menu.open) return; menu.open = false; if (focus) $("summary", menu).focus(); };
    menu.addEventListener("click", (e) => { if (e.target.closest("a")) close(false); });
    // Escape gives focus back to the button only when focus was in the list
    d.addEventListener("keydown", (e) => { if (e.key === "Escape") close(menu.contains(d.activeElement)); });
    d.addEventListener("pointerdown", (e) => { if (!menu.contains(e.target)) close(false); });
    // tabbing out of the list closes it, so it never covers the control that has focus
    menu.addEventListener("focusout", (e) => { if (e.relatedTarget && !menu.contains(e.relatedTarget)) close(false); });
  }

  /* ── selectors with a sliding indicator (tabs: underline; pill: pill) ── */
  function selector(seg, onChange) {
    const items = $$(".seg-item", seg), ind = $(".seg-indicator", seg), pill = seg.classList.contains("seg--pill");
    let current = Math.max(0, items.findIndex((b) => b.getAttribute("aria-selected") === "true"));
    const place = () => {
      const b = items[current];
      if (!ind || !b) return;
      if (pill) { ind.style.setProperty("--x", (b.offsetLeft - 4) + "px"); ind.style.setProperty("--y", (b.offsetTop - 4) + "px"); }
      else { ind.style.setProperty("--x", b.offsetLeft + "px"); ind.style.setProperty("--w", String(b.offsetWidth)); }
    };
    const select = (i, focus) => {
      current = (i + items.length) % items.length;
      items.forEach((b, n) => { const on = n === current; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; });
      place();
      if (focus) items[current].focus();
      if (!pill) { // keep the chosen tab inside the strip without ever scrolling the page
        const t = items[current], l = t.offsetLeft, r = l + t.offsetWidth;
        if (l < seg.scrollLeft) seg.scrollLeft = l; else if (r > seg.scrollLeft + seg.clientWidth) seg.scrollLeft = r - seg.clientWidth;
      }
      onChange(current, items[current]);
    };
    items.forEach((b, i) => b.addEventListener("click", () => select(i)));
    seg.addEventListener("keydown", (e) => {
      const k = e.key;
      const to = k === "ArrowRight" || k === "ArrowDown" ? current + 1 : k === "ArrowLeft" || k === "ArrowUp" ? current - 1 : k === "Home" ? 0 : k === "End" ? items.length - 1 : null;
      if (to === null) return;
      e.preventDefault(); select(to, true);
    });
    addEventListener("resize", place, { passive: true });
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(place);
    place();
    return { select, get index() { return current; } };
  }

  /* ── the opening: plays once from CSS; any input finishes it at once; it can be played again ── */
  const opening = $(".opening");
  if (opening) {
    const replay = $(".opening-replay", opening), last = $(".card--hwp", opening);
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    let armed = false;
    const done = (e) => {
      if (opening.classList.contains("is-done")) return;
      // pressing 다시 보기 while it plays finishes the run; the click that follows must not start another
      if (e && e.target && e.target.closest && e.target.closest(".opening-replay")) replay.dataset.skipped = "1";
      opening.classList.add("is-done");
      replay.removeAttribute("aria-disabled");
      if (!reduce.matches) replay.hidden = false;
      events.forEach((t) => removeEventListener(t, done, true)); armed = false;
    };
    const arm = () => { if (armed) return; armed = true; events.forEach((t) => addEventListener(t, done, { capture: true, passive: true })); };
    if (reduce.matches) done();
    else {
      arm();
      last.addEventListener("animationend", (e) => { if (e.animationName === "card-go") done(); });
      d.addEventListener("visibilitychange", () => { if (d.hidden) done(); });
    }
    // playing again keeps the button (and keyboard focus) where it is; it waits until the run ends
    replay.addEventListener("click", (e) => {
      e.stopPropagation();
      if (replay.dataset.skipped) { delete replay.dataset.skipped; return; }
      if (replay.getAttribute("aria-disabled") === "true") return;
      replay.setAttribute("aria-disabled", "true");
      opening.classList.remove("is-done");
      void opening.offsetWidth;
      setTimeout(arm, 0);
    });
    // where scroll timelines do not exist, the window's tilt flattens from a rAF reader
    const tilt = $(".win-tilt", opening);
    if (!reduce.matches && !(window.CSS && CSS.supports && CSS.supports("animation-timeline: scroll()"))) {
      let q = false;
      const flat = () => { q = false; const k = Math.min(1, scrollY / (innerHeight * 0.7)); tilt.style.transform = k >= 1 ? "" : "rotateX(" + (11 * (1 - k)).toFixed(2) + "deg) scale(" + (0.96 + 0.04 * k).toFixed(4) + ")"; };
      addEventListener("scroll", () => { if (!q) { q = true; requestAnimationFrame(flat); } }, { passive: true });
      flat();
    }
  }

  /* ── tour: while the window is pinned, how far the tall track has been scrolled decides which text is up ── */
  const run = $(".tour-run");
  if (run) {
    const steps = $$(".tour-step", run), stage = $(".tour-stage", run);
    let queued = false, active = 0;
    const progress = () => { const r = run.getBoundingClientRect(), span = r.height - stage.offsetHeight; return span > 0 ? Math.min(1, Math.max(0, (stage.getBoundingClientRect().top - r.top) / span)) : 0; };
    const navs = $$(".tour-nav button", run);
    const sync = () => {
      queued = false;
      if (!pinned.matches) return;
      const i = Math.min(steps.length - 1, Math.floor(progress() * steps.length));
      if (i === active) return;
      active = i;
      steps.forEach((s, n) => s.classList.toggle("is-active", n === i));
      navs.forEach((b, n) => { if (n === i) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current"); });
    };
    // the step list moves the page to the middle of that step's stretch of the track (native scrolling)
    navs.forEach((b, n) => b.addEventListener("click", () => {
      const r = run.getBoundingClientRect(), span = r.height - stage.offsetHeight;
      scrollTo({ top: scrollY + r.top + span * (n + 0.5) / steps.length, behavior: reduce.matches ? "auto" : "smooth" });
    }));
    const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(sync); } };
    // listen only while the run is near the viewport
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => entries.forEach((en) => {
        if (en.isIntersecting) { addEventListener("scroll", onScroll, { passive: true }); sync(); }
        else { removeEventListener("scroll", onScroll); sync(); }
      }), { rootMargin: "50% 0px 50% 0px" }).observe(run);
    } else addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll, { passive: true });
    run.progress = progress;
  }

  /* ── progress: CSS scroll timelines where they exist, one rAF reader elsewhere ── */
  const cssTimeline = window.CSS && CSS.supports && CSS.supports("animation-timeline: scroll()") && !reduce.matches;
  if (!cssTimeline) {
    const bar = $(".read-progress i"), rail = $(".tour-rail i");
    let queued = false;
    const read = () => {
      queued = false;
      const max = root.scrollHeight - innerHeight;
      if (bar) bar.style.setProperty("--p", max > 0 ? Math.min(1, scrollY / max).toFixed(4) : "0");
      if (rail && run && pinned.matches) rail.style.setProperty("--p", run.progress().toFixed(4));
    };
    addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(read); } }, { passive: true });
    read();
  }

  /* ── colour sets: the chosen set's frame is fetched when asked for; the frame on screen stays until it has arrived ── */
  const sets = $(".sets");
  if (sets) {
    const radios = $$(".set", sets), base = $(".sets-stage picture img", sets), overs = $$(".sets-img--over", sets), now = $(".sets-now", sets);
    const avif = () => { const s = base.currentSrc || ""; return s.indexOf(".avif") > -1 || s.slice(0, 16).indexOf("image/avif") > -1; };
    const src = (b) => (avif() || !b.dataset.webp ? b.dataset.avif : b.dataset.webp);
    let token = 0, top = -1;
    const choose = (b, focus, quiet) => {
      radios.forEach((r) => { const on = r === b; r.setAttribute("aria-checked", String(on)); r.tabIndex = on ? 0 : -1; });
      if (focus) b.focus();
      const mine = ++token, img = new Image();
      img.onload = () => {
        if (mine !== token) return;
        const next = overs[(top + 1) % overs.length], prev = overs[top];
        next.src = img.src; next.hidden = false;
        // two frames so the opacity change is seen as a change
        requestAnimationFrame(() => requestAnimationFrame(() => {
          next.classList.add("is-in");
          next.parentNode.appendChild(next); // the newest frame is the top layer
          if (prev) setTimeout(() => { if (mine === token) prev.classList.remove("is-in"); }, reduce.matches ? 0 : 760);
        }));
        top = overs.indexOf(next);
        const name = b.textContent.trim();
        // a choice the page makes by itself is not announced
        if (quiet) now.setAttribute("aria-live", "off");
        now.textContent = "지금 보이는 색: " + name;
        if (quiet) setTimeout(() => now.setAttribute("aria-live", "polite"), 300);
        base.alt = "프로젝트 화면을 " + name + " 색 조합으로 본 모습. 왼쪽에 대화, 오른쪽에 문서가 있다.";
      };
      img.src = src(b);
    };
    radios.forEach((b) => {
      b.addEventListener("click", () => choose(b));
      b.addEventListener("pointerenter", () => { const p = new Image(); p.src = src(b); }, { once: true });
    });
    $(".sets-groups", sets).addEventListener("keydown", (e) => {
      const i = radios.indexOf(d.activeElement);
      if (i < 0) return;
      const k = e.key, to = k === "ArrowRight" || k === "ArrowDown" ? i + 1 : k === "ArrowLeft" || k === "ArrowUp" ? i - 1 : k === "Home" ? 0 : k === "End" ? radios.length - 1 : null;
      if (to === null) return;
      e.preventDefault(); choose(radios[(to + radios.length) % radios.length], true);
    });
    // on a dark page start from the app's default dark set, once the section is near
    if (themeNow() === "dark" && "IntersectionObserver" in window) {
      const io = new IntersectionObserver((en) => { if (en[0].isIntersecting) { io.disconnect(); if (token === 0) choose(radios.find((r) => r.dataset.set === "graphite"), false, true); } }, { rootMargin: "60% 0px" });
      io.observe(sets);
    }
  }

  /* ── tab sleep chart: bars grow when seen, then the chart moves to the asleep state once; the switch moves it back ── */
  const chart = $(".sleep-chart");
  if (chart) {
    const num = $(".sleep-num", chart);
    let touched = false;
    chart.dataset.state = "awake";
    if (chart.closest(".mem-stage")) chart.closest(".mem-stage").dataset.state = "awake";
    const stage = chart.closest(".mem-stage");
    let visible = false;
    const set = (state) => {
      chart.dataset.state = state;
      if (stage) stage.dataset.state = state;
      const to = parseFloat(num.dataset[state]);
      if (reduce.matches) { num.textContent = to.toFixed(1); return; }
      const from = parseFloat(num.textContent) || to, t0 = performance.now();
      const frame = (t) => { const k = Math.min(1, (t - t0) / 700), e = 1 - Math.pow(1 - k, 3); num.textContent = (from + (to - from) * e).toFixed(1); if (k < 1) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    };
    const sw = selector($(".sleep-switch", chart), (i, b) => set(b.dataset.state));
    $(".sleep-switch", chart).addEventListener("pointerdown", () => { touched = true; });
    $(".sleep-switch", chart).addEventListener("keydown", () => { touched = true; });
    if ("IntersectionObserver" in window) {
      let started = false;
      const io = new IntersectionObserver((en) => {
        visible = en[0].isIntersecting;
        if (!visible || started) return;
        started = true; chart.classList.add("is-in");
        // the chart moves to the asleep state by itself once, only if it is still on screen and nobody used the switch
        if (!reduce.matches) setTimeout(() => { if (!touched && visible) sw.select(1); }, 2600);
      }, { threshold: 0.45 });
      io.observe(chart);
    } else chart.classList.add("is-in");
  }

  /* ── OS chooser: preselect this computer's system, show one panel ── */
  const os = $(".os");
  if (os) {
    const panels = $$(".os-panel", os);
    const pick = selector($(".seg--pill", os), (i) => panels.forEach((p, n) => p.classList.toggle("is-on", n === i)));
    const ua = navigator.userAgent, plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    pick.select(/Mac|iPhone|iPad/.test(plat + ua) ? 1 : /Linux|X11/.test(plat + ua) && !/Android/.test(ua) ? 2 : 0);
  }

  /* ── the closing action names this computer's file (the link itself always goes to the release page) ── */
  const get = $(".close-get");
  if (get) {
    const ua = navigator.userAgent, plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    const mobile = /Android|iPhone|iPad/.test(ua);
    const pick = mobile ? null : /Mac/.test(plat + ua) ? ["macOS용 내려받기", "Achmage.Workbench_0.5.1_aarch64.dmg, 167 MB (Apple silicon)"]
      : /Win/.test(plat + ua) ? ["Windows용 내려받기", "Achmage.Workbench_0.5.1_x64-setup.exe, 129 MB"]
      : /Linux|X11/.test(plat + ua) ? ["Linux용 내려받기", "Achmage.Workbench_0.5.1_amd64.AppImage, 231 MB (deb, Arch용도 같은 곳에 있습니다)"] : null;
    if (pick) {
      $$(".close-get-label", get).forEach((s) => { s.textContent = pick[0]; });
      const f = $(".close-file"); f.textContent = pick[1]; f.hidden = false;
    }
  }

  /* ── copy: the copy mark turns into a check, and the result is said aloud ── */
  $$(".copy").forEach((b) => b.addEventListener("click", async () => {
    const text = ($(b.dataset.copy) || {}).textContent || "", status = $("#copy-status");
    try { await navigator.clipboard.writeText(text); } catch (_) {
      const t = d.createElement("textarea"); t.value = text; d.body.appendChild(t); t.select();
      try { d.execCommand("copy"); } catch (__) {} t.remove();
    }
    b.classList.add("is-done"); if (status) status.textContent = "설치 명령을 복사했습니다.";
    setTimeout(() => { b.classList.remove("is-done"); if (status) status.textContent = ""; }, 1800);
  }));

  /* ── in the single-file form the whole frames are data: addresses, which cannot be opened as pages: hand them over as blobs ── */
  d.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="data:image"]');
    if (!a) return;
    e.preventDefault();
    fetch(a.href).then((r) => r.blob()).then((blob) => { open(URL.createObjectURL(blob), "_blank", "noopener"); }).catch(() => {});
  });

  /* ── measured values roll up once when first seen (after magicui number-ticker) ── */
  const tickers = $$(".ticker");
  if (tickers.length && "IntersectionObserver" in window && !reduce.matches) {
    const rollUp = (el) => {
      const to = parseFloat(el.dataset.to), dec = parseInt(el.dataset.decimals || "0", 10), t0 = performance.now(), dur = 900;
      const frame = (t) => {
        const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
        el.textContent = (to * e).toFixed(dec);
        if (k < 1) requestAnimationFrame(frame); else el.textContent = to.toFixed(dec);
      };
      requestAnimationFrame(frame);
    };
    const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { io.unobserve(en.target); rollUp(en.target); } }), { threshold: 0.6 });
    tickers.forEach((el) => io.observe(el));
  }
})();
