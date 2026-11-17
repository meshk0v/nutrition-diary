/* Дневник питания — Telegram Mini App. Данные: Google Apps Script API (config.js). */
(function () {
  'use strict';

  const tg = window.Telegram && Telegram.WebApp;
  const inTelegram = !!(tg && tg.initData);
  const API = window.APP_CONFIG.api;
  const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  // Кэш привязан к пользователю Telegram (в демо — отдельный), чтобы не показать чужие данные
  const tgUserId = inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : 'demo';
  const CACHE_KEY = 'nutrition-app-v2-' + tgUserId;
  try { localStorage.removeItem('nutrition-app-v1'); } catch (e) {}

  let state = null;          // ответ init
  let items = [];            // справочник [{name, type, kcal, p, f, c, portion}]
  let menuDay = 0;

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n, d = 0) => n == null || n === '' ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const norm = s => String(s).toLowerCase().replace(/ё/g, 'е');
  const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const haptic = t => { try { tg && tg.HapticFeedback && (t === 'ok' ? tg.HapticFeedback.notificationOccurred('success') : tg.HapticFeedback.impactOccurred('light')); } catch (e) {} };

  /* ---------- Telegram ---------- */
  if (tg) {
    tg.ready();
    tg.expand();
    // Полный экран (Bot API 8.0+) на телефонах; на старых клиентах остаётся обычное раскрытие
    try {
      if (tg.requestFullscreen && /^(android|android_x|ios)$/.test(tg.platform || '') && !tg.isFullscreen) tg.requestFullscreen();
    } catch (e) {}
    document.documentElement.dataset.theme = tg.colorScheme || 'light';
    tg.onEvent('themeChanged', () => { document.documentElement.dataset.theme = tg.colorScheme; });
    try { tg.setHeaderColor('secondary_bg_color'); } catch (e) {}
    // свайп вниз не сворачивает приложение — иначе оно закрывается при прокрутке окон
    try { if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); } catch (e) {}
  }

  // Поля с классом grow подстраивают высоту под текст (до половины экрана, дальше — прокрутка внутри)
  const autoGrow = el => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight + 2, window.innerHeight * 0.5) + 'px'; };
  document.addEventListener('input', e => { if (e.target.classList && e.target.classList.contains('grow')) autoGrow(e.target); });

  // Тап по пустому месту (не по полю, кнопке или ссылке) убирает клавиатуру
  document.addEventListener('click', e => {
    const a = document.activeElement;
    if (!a || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    if (e.target.closest('input, textarea, select, button, a, label')) return;
    a.blur();
  });

  /* ---------- API ---------- */
  async function api(action, data = {}) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, initData: inTelegram ? tg.initData : '', demo: !inTelegram }, data))
      });
      const json = await res.json();
      if (json.error) throw Object.assign(new Error(json.message || json.error), { code: json.error, id: json.id, anketa: json.anketa, anketaSent: json.anketaSent });
      return json;
    } finally { /* индикатор загрузки убран — состояние видно по кнопкам («Отправляю…») */ }
  }

  function toast(text) {
    const t = $('#toast');
    t.textContent = text; t.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  /* ---------- Загрузка ---------- */
  function loadCache() {
    try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if (c && c.date) return c; } catch (e) {}
    return null;
  }
  function saveCache() { try { localStorage.setItem(CACHE_KEY, JSON.stringify(state)); } catch (e) {} }

  // Анимация загрузки из loader.json (LottieFiles, Lottie Simple License); при любой ошибке остаётся обычный индикатор
  function startLoader() {
    try {
      if (!window.lottie) return;
      fetch('loader.json').then(r => r.json()).then(j => {
        if (!document.body.classList.contains('booting')) return;
        window.lottie.loadAnimation({ container: $('#bootAnim'), renderer: 'svg', loop: true, autoplay: true, animationData: j });
        $('#boot').classList.add('has-anim');
      }).catch(() => {});
    } catch (e) {}
  }

  async function init() {
    startLoader();
    const cached = loadCache();
    if (cached) { apply(cached); endBoot(); } // есть сохранённые данные — показываем сразу, без заставки
    try {
      apply(await api('init'));
      saveCache();
      openFromHash();
      $('#helpBtn').classList.toggle('hidden', false);
      if (!tourSeen()) setTimeout(startTour, 400); // первый запуск — короткое обучение
    } catch (e) {
      // Ошибки доступа (нет в группе, не удалось войти, участие завершено) — всегда показываем, кэш стираем
      if (!state || ['not_registered', 'unauthorized', 'finished', 'no_demo', 'maintenance'].includes(e.code)) {
        try { localStorage.removeItem(CACHE_KEY); } catch (err) {}
        showError(e);
      } else toast('Нет связи с таблицей, показаны сохранённые данные');
    } finally { endBoot(); }
  }

  // Заставка загрузки: пока не знаем, кто открыл приложение, не рисуем ни шапку, ни нижнее меню
  function endBoot() { document.body.classList.remove('booting'); }

  function skeleton() {
    $('#reportForm').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  }

  /* ---------- Анкета (для тех, кого ещё нет в группе) ---------- */
  function showAnketa(e) {
    $('#hello').textContent = 'Добро пожаловать!';
    $('#sub').textContent = 'Анкета перед стартом';
    $('.tabs').classList.add('hidden');
    if (e.anketaSent) {
      $('main').innerHTML = `<div class="error-box"><div class="big">✅</div><h2>Анкета отправлена</h2>
        <p class="muted">Тренер добавит вас в группу — бот пришлёт сообщение, и приложение откроется.</p>
        <button class="btn" onclick="location.reload()">Обновить</button></div>`;
      return;
    }
    const field = q => {
      const [key, label, type] = q;
      if (type.startsWith('select:')) return `<div class="choice"><input type="hidden" name="${key}">${type.slice(7).split('|').map(o => `<button type="button" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
      if (type === 'num') return `<input name="${key}" inputmode="decimal">`;
      // текстовые ответы — растущее поле: ширина строки, дальше растёт по мере набора
      return `<textarea name="${key}" class="grow" rows="${type === 'area' ? 3 : 2}"></textarea>`;
    };
    $('main').innerHTML = `<form class="card anketa" id="anketaForm" autocomplete="off">
      <h2>Анкета перед стартом</h2>
      <div class="muted" style="margin-top:4px">Заполните до начала — тренер по ней рассчитает ваш калораж. Ответы увидит только тренер.</div>
      ${e.anketa.map(sec => `<h3>${esc(sec[0])}</h3>` + sec[1].map(q => `<div class="fld"><div class="lbl">${esc(q[1])}</div>${field(q)}</div>`).join('')).join('')}
      <button class="btn primary full" type="submit">Отправить анкету тренеру</button></form>`;
    // Выбор из вариантов — кнопками; повторный тап снимает выбор
    $$('#anketaForm .choice').forEach(box => box.addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      const was = b.classList.contains('on');
      $$('button', box).forEach(x => x.classList.remove('on'));
      $('input', box).value = was ? '' : b.dataset.v;
      if (!was) { b.classList.add('on'); haptic(); }
    }));
    $('#anketaForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const fd = new FormData(ev.target), answers = {};
      fd.forEach((v, k) => { answers[k] = String(v).trim(); });
      if (!answers.name) { toast('Укажите имя и фамилию'); return; }
      const btn = $('button[type=submit]', ev.target);
      btn.disabled = true; btn.textContent = 'Отправляю…';
      try {
        await api('anketa', { answers });
        haptic('ok'); window.scrollTo(0, 0);
        showAnketa(Object.assign({}, e, { anketaSent: true }));
      } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Отправить анкету тренеру'; }
    });
  }

  // Заглушка «Приложение в разработке» (тренер включает/выключает в «Настройках»)
  function showMaintenance(e) {
    $('.top').classList.add('hidden');
    $('#demoBanner').classList.add('hidden');
    $('.tabs').classList.add('hidden');
    $('main').innerHTML = `<div class="dev-box">${esc(e.message || 'Приложение в разработке 🚧')}</div>`;
  }

  function showError(e) {
    if (e.code === 'maintenance') return showMaintenance(e);
    if (e.code === 'not_registered' && e.anketa) return showAnketa(e);
    const msgs = {
      not_registered: ['🙋', 'Вас пока нет в группе', 'Тренер добавит вас — после этого откройте дневник снова.'],
      unauthorized: ['🔒', 'Не удалось войти', e.message],
      finished: ['👋', 'Участие завершено', e.message],
      no_demo: ['📱', 'Откройте из Telegram', e.message]
    };
    const [icon, title, text] = msgs[e.code] || ['⚠️', 'Ошибка загрузки', 'Проверьте интернет и попробуйте снова. ' + (e.message || '')];
    $('main').innerHTML = `<div class="error-box"><div class="big">${icon}</div><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
      <button class="btn" onclick="location.reload()">Обновить</button></div>`;
    $('.tabs').classList.add('hidden');
    $('#sub').textContent = '';
  }

  function apply(data) {
    state = data;
    if (inTelegram && data.demo) data.demo = false;
    items = (data.items || []).map(a => ({ name: a[0], type: a[1], kcal: a[2], p: a[3], f: a[4], c: a[5], portion: a[6] || 0 }));
    const d = parseDate(data.date);
    $('#hello').textContent = 'Привет, ' + data.me.name + '!';
    $('#sub').textContent = `${DAYS[(d.getDay() + 6) % 7]}, ${d.getDate()} ${MONTHS[d.getMonth()]}` + (data.me.target ? ` · план ${fmt(data.me.target)} ккал` : '');
    $('#demoBanner').classList.toggle('hidden', !data.demo);
    renderReport(); renderResults(); renderMenu(); renderRations(); renderProgress();
  }

  function confirmAsk(text) {
    return new Promise(res => tg && tg.showConfirm && inTelegram ? tg.showConfirm(text, res) : res(window.confirm(text)));
  }

  /* ---------- Нижние окна (рецепт, рацион) ---------- */
  // Пока открыто окно — фон не прокручивается: фиксируем body на текущей позиции (надёжно и в iOS-webview Telegram)
  let lockedY = 0;
  function lockScroll() {
    if (document.body.classList.contains('sheet-open')) return;
    lockedY = window.scrollY;
    document.body.style.top = -lockedY + 'px';
    document.body.classList.add('sheet-open');
  }
  function unlockScroll() {
    if (!document.body.classList.contains('sheet-open')) return;
    document.body.classList.toggle('sheet-open', false);
    document.body.style.top = '';
    window.scrollTo(0, lockedY);
  }
  function openSheet(id) {
    $$('.sheet').forEach(s => s.classList.add('hidden'));
    $(id).classList.toggle('hidden', false);
    lockScroll();
    if (tg && tg.BackButton) { tg.BackButton.show(); }
  }
  function closeSheets() {
    $$('.sheet').forEach(s => s.classList.add('hidden'));
    unlockScroll();
    if (tg && tg.BackButton) tg.BackButton.hide();
  }
  if (tg && tg.BackButton) tg.BackButton.onClick(closeSheets);
  $$('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
  $$('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s) closeSheets(); }));

  // КБЖУ для количества: граммы, или штуки/порции × вес порции из справочника
  function calc(it, qty, u) {
    const grams = u === 'г' ? qty : qty * (it.portion || 0);
    const k = grams / 100;
    return { grams, kcal: it.kcal * k, p: it.p * k, f: it.f * k, c: it.c * k };
  }

  /* ---------- Меню ---------- */
  // Кнопка «Рецепт →» у блюд, для которых есть рецепт (false — скрыть)
  const SHOW_RECIPES = true;

  function renderMenu() {
    const m = state.menu;
    if (!m) {
      $('#menuHead').innerHTML = '<div class="title">Меню пока не назначено</div><div class="muted">Тренер пришлёт его в бот, и оно появится здесь.</div>';
      $('#dayChips').innerHTML = ''; $('#dayMeals').innerHTML = '';
      return;
    }
    $('#menuHead').innerHTML = `<div class="code">${esc(m.code)}</div><div class="title">${esc(m.name || 'Меню на неделю')}</div><div class="muted">Неделя ${esc(m.period)}${m.target ? ' · ' + fmt(m.target) + ' ккал в день' : ''}${m.auto && state.me.target && state.me.target !== m.target ? ' · подобрано под ваш калораж ' + fmt(state.me.target) : ''}</div>`;
    const todayIdx = m.days.findIndex(d => d.date === state.date);
    if (renderMenu.first !== false) { menuDay = todayIdx >= 0 ? todayIdx : 0; renderMenu.first = false; }
    $('#dayChips').innerHTML = m.days.map((d, i) => `<button data-d="${i}" class="${i === menuDay ? 'on' : ''} ${i === todayIdx ? 'today' : ''}">${d.day}<small>${parseDate(d.date).getDate()}</small></button>`).join('');
    const day = m.days[menuDay];
    $('#dayMeals').innerHTML = `<div class="day-total"><span>${day.full}</span><span>${fmt(day.total.kcal)} ккал · Б ${fmt(day.total.p)} Ж ${fmt(day.total.f)} У ${fmt(day.total.c)}</span></div>` +
      (day.meals.length ? day.meals.map((x, i) => `
        <div class="meal">
          <div class="when">${esc(x.meal)}</div>
          <div class="dish">${esc(x.item)}</div>
          <div class="nut">${fmt(x.qty, 2)} ${esc(x.unit)}${x.grams && x.unit !== 'г' ? ' · ≈' + fmt(x.grams) + ' г' : ''} · ${fmt(x.kcal)} ккал · Б ${fmt(x.p, 1)} Ж ${fmt(x.f, 1)} У ${fmt(x.c, 1)}</div>
          ${SHOW_RECIPES && state.recipes && state.recipes[x.item] ? `<div class="row"><button class="link" data-recipe="${i}">Рецепт →</button></div>` : ''}
        </div>`).join('') : '<div class="empty">На этот день блюд нет</div>');
  }
  $('#dayChips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; menuDay = +b.dataset.d; renderMenu(); haptic(); });
  $('#dayMeals').addEventListener('click', e => {
    if (!state.menu) return;
    const day = state.menu.days[menuDay];
    const rb = e.target.closest('[data-recipe]');
    if (rb) openRecipe(day.meals[+rb.dataset.recipe]);
  });

  function openRecipe(x) {
    const r = state.recipes[x.item];
    // во сколько раз ингредиентов меньше/больше, чем в целом рецепте, при этой порции
    const portions = x.unit === 'г' && r.portion ? x.qty / r.portion : Number(x.qty) || 1;
    const k = portions / (r.portions || 1);
    $('#rTitle').textContent = x.item;
    // Состав на порцию участника в формате тренера: «продукт — граммы — ккал» (ккал по справочнику)
    let total = 0;
    const rows = r.items.map(([n, g]) => {
      const grams = g * k, it = items.find(i => i.name === n);
      const kcal = it ? grams * it.kcal / 100 : null;
      if (kcal != null) total += kcal;
      return `<div class="ing"><span>${esc(n)}</span><span class="ing-r"><b>${fmt(grams)} г</b>${kcal != null ? ` · ${fmt(kcal)} ккал` : ''}</span></div>`;
    }).join('');
    $('#rBody').innerHTML = `<div style="margin-top:4px">${rows}</div>` +
      (total ? `<div class="ing ing-total"><span>Итого</span><span class="ing-r"><b>${fmt(total)} ккал</b></span></div>` : '');
    openSheet('#recipeSheet');
  }

  /* ---------- Итоги (прогресс участника) ---------- */
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sign = (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v), d);

  function upsertHistory(rep) {
    if (!rep) return;
    state.history60 = (state.history60 || []).filter(x => x.date !== rep.date);
    const n = k => (rep[k] === '' || rep[k] == null ? null : Number(rep[k]));
    state.history60.push({ date: rep.date, kcal: n('kcal'), p: n('p'), f: n('f'), c: n('c'), hunger: n('hunger'), weight: n('weight'), steps: n('steps'), water: n('water'), tea: n('tea'), veg: n('veg') });
    state.history60.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  // последние n дней (с сегодняшним), но не раньше старта участника
  function lastDays(n) {
    const out = [], t = parseDate(state.date), start = state.me.start || '';
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(t); d.setDate(d.getDate() - i);
      const key = ymd(d);
      if (!start || key >= start) out.push({ key, d });
    }
    return out;
  }

  /** Столбики по дням. target — число (линия), band — {min,max} (полоса), okFn(v) — в норме ли. */
  function barChart(days, values, opt) {
    const W = 320, H = 150, padB = 18, padT = 8;
    const vmax = Math.max(1, ...values.filter(v => v != null), opt.target || 0, opt.band ? opt.band.max : 0) * 1.12;
    const y = v => padT + (H - padT - padB) * (1 - v / vmax);
    const bw = (W / days.length) * 0.66, step = W / days.length;
    let svg = '';
    if (opt.band) svg += `<rect class="band" x="0" y="${y(opt.band.max)}" width="${W}" height="${Math.max(2, y(opt.band.min) - y(opt.band.max))}" rx="3"/>`;
    days.forEach((dd, i) => {
      const v = values[i], x = i * step + (step - bw) / 2;
      const cls = v == null ? 'none' : opt.okFn(v) ? 'ok' : 'off';
      const h = v == null ? 3 : Math.max(3, H - padB - y(v));
      svg += `<rect class="${cls}" x="${x.toFixed(1)}" y="${(H - padB - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3"><title>${dd.d.getDate()}.${dd.d.getMonth() + 1}: ${v == null ? 'нет отчёта' : fmt(v)}</title></rect>`;
      if (days.length <= 14 || i % 2 === 0) svg += `<text class="lab" x="${(x + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${dd.d.getDate()}</text>`;
    });
    if (opt.target) svg += `<line class="tgt" x1="0" x2="${W}" y1="${y(opt.target)}" y2="${y(opt.target)}"/>`;
    return `<div class="vchart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg}</svg></div>`;
  }

  function renderResults() {
    const hist = state.history60 || [];
    const byDate = {}; hist.forEach(h => { byDate[h.date] = h; });
    const me = state.me, corridor = state.corridor || 0.15;
    const days14 = lastDays(14);

    // --- карточки
    const w = (state.weights || []).filter(x => x.weight);
    const wDelta = w.length >= 2 ? w[w.length - 1].weight - w[0].weight : null;
    const ms = state.measures || [];
    const firstWaist = ms.find(m => m.waist), lastWaist = [...ms].reverse().find(m => m.waist);
    const waistDelta = firstWaist && lastWaist && firstWaist !== lastWaist ? lastWaist.waist - firstWaist.waist : null;
    const sent14 = days14.filter(d => byDate[d.key]).length;
    let streak = 0;
    for (const d of [...lastDays(60)].reverse()) {
      if (byDate[d.key]) streak++;
      else if (d.key === state.date) continue; // сегодняшний ещё можно сдать до 0:00
      else break;
    }
    const goodWeight = wDelta == null ? '' : (me.goal === 'Набор массы' ? (wDelta > 0 ? 'good' : '') : (wDelta < 0 ? 'good' : wDelta > 0 ? 'bad' : ''));
    const cards = [
      [wDelta == null ? '—' : sign(wDelta) + ' кг', wDelta == null ? 'вес: нужно 2+ взвешивания' : 'вес с ' + parseDate(w[0].date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }), goodWeight],
      [waistDelta == null ? '—' : sign(waistDelta) + ' см', waistDelta == null ? 'талия: нужно 2+ замера' : 'талия с первого замера', waistDelta == null ? '' : waistDelta < 0 ? 'good' : waistDelta > 0 ? 'bad' : ''],
      [`${sent14} из ${days14.length}`, 'отчётов сдано за последние ' + days14.length + ' дн.', sent14 >= days14.length - 1 ? 'good' : ''],
      [streak ? '🔥 ' + streak : '0', streak ? 'дней подряд с отчётом' : 'серия отчётов — начните сегодня', streak >= 3 ? 'good' : '']
    ];
    $('#resCards').innerHTML = cards.map(c => `<div class="res-card ${c[2]}"><b>${c[0]}</b><small>${esc(c[1])}</small></div>`).join('');

    // --- калории
    const kv = days14.map(d => (byDate[d.key] ? byDate[d.key].kcal : null));
    const okK = v => !me.target || Math.abs(v / me.target - 1) <= corridor;
    $('#kcalChart').innerHTML = barChart(days14, kv, { target: me.target, okFn: okK }) +
      `<div class="legend"><span><i style="background:var(--accent)"></i>в коридоре ±${Math.round(corridor * 100)}%</span><span><i style="background:var(--warn)"></i>вне коридора</span><span><i style="background:var(--line)"></i>нет отчёта</span>${me.target ? '<span>- - цель ' + fmt(me.target) + '</span>' : ''}</div>`;
    const kDone = kv.filter(v => v != null);
    $('#kcalAvg').textContent = kDone.length ? 'в среднем ' + fmt(kDone.reduce((a, b) => a + b, 0) / kDone.length) + ' ккал' : '';

    // --- белок
    const pv = days14.map(d => (byDate[d.key] && byDate[d.key].p != null ? byDate[d.key].p : null));
    const band = me.tPr && me.tPr.min !== me.tPr.max ? { min: me.tPr.min, max: me.tPr.max } : null;
    const okP = v => !me.tPr || (band ? v >= band.min && v <= band.max * 1.1 : Math.abs(v / me.tPr.mid - 1) <= corridor);
    $('#protChart').innerHTML = barChart(days14, pv, { band, target: band ? null : (me.tPr ? me.tPr.mid : null), okFn: okP }) +
      `<div class="legend">${me.tPr ? `<span><i style="background:var(--accent);opacity:.35"></i>планка ${esc(me.tPr.text)} г</span>` : '<span>планку по белку тренер ещё не выдал</span>'}</div>`;
    const pDone = pv.filter(v => v != null);
    $('#protAvg').textContent = pDone.length ? 'в среднем ' + fmt(pDone.reduce((a, b) => a + b, 0) / pDone.length) + ' г' : '';

    // --- по неделям (последние 4 недели с понедельника)
    const today = parseDate(state.date);
    const mon = new Date(today); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    const weeks = [];
    for (let k = 0; k < 4; k++) {
      const a = new Date(mon); a.setDate(a.getDate() - 7 * k);
      const b = new Date(a); b.setDate(b.getDate() + 6);
      const rows = hist.filter(h => h.date >= ymd(a) && h.date <= ymd(b));
      if (!rows.length) continue;
      const avg = key => { const v = rows.map(r => r[key]).filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
      weeks.push({ label: k === 0 ? 'эта' : `${a.getDate()}.${String(a.getMonth() + 1).padStart(2, '0')}`, n: rows.length,
        kcal: avg('kcal'), p: avg('p'), steps: avg('steps'), water: avg('water'), hunger: avg('hunger'), weight: avg('weight') });
    }
    $('#weeksTable').innerHTML = weeks.length ? `<table class="wtable"><tr><th>неделя</th><th>отчётов</th><th>ккал</th><th>белок</th><th>шаги</th><th>вода</th><th>голод</th><th>вес</th></tr>` +
      weeks.map(x => `<tr><td>${x.label}</td><td>${x.n}/7</td><td>${fmt(x.kcal)}</td><td>${fmt(x.p)}</td><td>${x.steps != null ? fmt(x.steps / 1000, 1) + 'к' : '—'}</td><td>${fmt(x.water, 1)}</td><td>${fmt(x.hunger, 1)}</td><td>${fmt(x.weight, 1)}</td></tr>`).join('') +
      '</table><div class="muted" style="margin-top:6px;font-size:11.5px">Средние значения по отчётам недели.</div>'
      : '<div class="empty" style="margin-top:8px">Появится после первых отчётов</div>';

    // --- замеры: первый → последний
    if (ms.length < 2) {
      $('#measProgress').innerHTML = `<div class="empty" style="margin-top:8px">${ms.length ? 'Нужен ещё один замер, чтобы увидеть изменения' : 'Замеров пока нет — по воскресеньям во вкладке «Замеры»'}</div>`;
    } else {
      const first = ms[0], last = ms[ms.length - 1];
      $('#measProgress').innerHTML = `<div class="muted" style="margin:4px 0 2px">${parseDate(first.date).toLocaleDateString('ru-RU')} → ${parseDate(last.date).toLocaleDateString('ru-RU')}</div>` +
        (state.metrics || []).map(([k, n, u]) => {
          if (first[k] == null || last[k] == null) return '';
          const d = last[k] - first[k];
          const good = k === 'weight' && me.goal === 'Набор массы' ? d > 0 : d < 0;
          return `<div class="mp-row"><span>${n}</span><span class="from">${fmt(first[k], 1)} →</span><b>${fmt(last[k], 1)} ${u}</b><span class="d ${d === 0 ? '' : good ? 'down' : 'up'}">${d === 0 ? '0' : sign(d)}</span></div>`;
        }).join('');
    }
  }

  /* ---------- Рационы ---------- */
  let raCurrent = null, raView = 'meals', raDays = 1;

  // Порции рациона подгоняются под калораж участника: множитель = цель / калорийность рациона
  function rationFactor(r) {
    const target = state.me.target;
    if (!target || !r.total.kcal) return 1;
    return Math.min(3, Math.max(0.5, Math.round(target / r.total.kcal * 20) / 20));
  }
  function scaleQty(qty, unit, f) {
    if (unit === 'г') return Math.max(5, Math.round(qty * f / 5) * 5);
    if (unit === 'шт') return Math.max(0.5, Math.round(qty * f * 2) / 2);
    return Math.max(0.1, Math.round(qty * f * 10) / 10);
  }
  function scaledRation(r) {
    const f = rationFactor(r);
    const meals = r.meals.map(m => {
      const it = items.find(i => i.name === m.item);
      const unit = m.unit || (it && it.type === 'r' ? 'порц' : 'г');
      const qty = scaleQty(m.qty, unit, f);
      const n = it ? calc(it, qty, unit) : { grams: m.grams * f, kcal: m.kcal * f, p: m.p * f, f: m.f * f, c: m.c * f };
      return Object.assign({}, m, { qty, unit, grams: n.grams, kcal: n.kcal, p: n.p, f: n.f, c: n.c });
    });
    const total = meals.reduce((t, m) => ({ kcal: t.kcal + m.kcal, p: t.p + m.p, f: t.f + m.f, c: t.c + m.c }), { kcal: 0, p: 0, f: 0, c: 0 });
    return { name: r.name, note: r.note, factor: f, meals, total };
  }

  function renderRations() {
    const list = (state.rations || []).map(scaledRation);
    $('#rationIntro').innerHTML = `<div class="title">Готовые рационы на день</div>
      <div class="muted" style="margin-top:4px">${state.me.target ? `Порции уже пересчитаны под вашу цель — ${fmt(state.me.target)} ккал.` : 'Выберите день и готовьте по нему.'} Внутри — рецепты и список покупок.</div>`;
    $('#rationList').innerHTML = list.length ? list.map((r, i) => `
      <button class="ration" data-ra="${i}">
        <div class="top"><div class="nm">${esc(r.name)}</div><div class="kc">${fmt(r.total.kcal)} ккал</div></div>
        <div class="dishes">${r.meals.map(m => esc(m.item)).join(' · ')}</div>
        <div class="mac">Б ${fmt(r.total.p)} · Ж ${fmt(r.total.f)} · У ${fmt(r.total.c)}${r.factor !== 1 ? ` · порции ×${fmt(r.factor, 2)}` : ''}</div>
      </button>`).join('') : '<div class="empty">Тренер пока не добавил рационы</div>';
  }
  $('#rationList').addEventListener('click', e => {
    const b = e.target.closest('[data-ra]'); if (!b) return;
    raCurrent = scaledRation(state.rations[+b.dataset.ra]); raView = 'meals'; raDays = 1;
    $('#raTitle').textContent = raCurrent.name;
    $('#raSub').textContent = `${fmt(raCurrent.total.kcal)} ккал · Б ${fmt(raCurrent.total.p)} Ж ${fmt(raCurrent.total.f)} У ${fmt(raCurrent.total.c)}`;
    renderRationSheet(); openSheet('#rationSheet'); haptic();
  });
  $('#raSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; raView = b.dataset.v; renderRationSheet(); });

  // Список покупок: рецепты раскладываются на ингредиенты (сырой вес), продукты — как есть
  function shoppingList(r, days) {
    const sum = {};
    const add = (name, g) => { sum[name] = (sum[name] || 0) + g; };
    r.meals.forEach(m => {
      const rec = state.recipes && state.recipes[m.item];
      if (rec && rec.items.length) {
        const eaten = m.unit === 'порц' ? m.qty : (rec.portion ? m.grams / rec.portion : m.qty);
        rec.items.forEach(([ing, g]) => add(ing, g * eaten / (rec.portions || 1)));
      } else add(m.item, m.grams || 0);
    });
    return Object.keys(sum).map(name => {
      const it = items.find(i => i.name === name);
      const g = Math.round(sum[name] * days / 5) * 5;
      const pcs = it && it.type === 'p' && it.portion ? Math.ceil(sum[name] * days / it.portion) : 0;
      return { name, g, pcs };
    }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  function renderRationSheet() {
    $$('#raSeg button').forEach(x => x.classList.toggle('on', x.dataset.v === raView));
    const r = raCurrent;
    if (raView === 'meals') {
      $('#raBody').innerHTML = (r.note ? `<p class="desc" style="margin-top:0">${esc(r.note)}</p>` : '') + r.meals.map((x, i) => `
        <div class="meal">
          <div class="when">${esc(x.meal)}</div>
          <div class="dish">${esc(x.item)}</div>
          <div class="nut">${fmt(x.qty, 2)} ${esc(x.unit)}${x.grams && x.unit !== 'г' ? ' · ≈' + fmt(x.grams) + ' г' : ''} · ${fmt(x.kcal)} ккал · Б ${fmt(x.p, 1)} Ж ${fmt(x.f, 1)} У ${fmt(x.c, 1)}</div>
          ${SHOW_RECIPES && state.recipes && state.recipes[x.item] ? `<div class="row"><button class="link" data-rrec="${i}">Рецепт →</button></div>` : ''}
        </div>`).join('');
    } else {
      const list = shoppingList(r, raDays);
      $('#raBody').innerHTML = `<div class="days-mult"><span class="muted">На сколько дней:</span>${[1, 3, 7].map(d => `<button data-days="${d}" class="${d === raDays ? 'on' : ''}">${d}</button>`).join('')}</div>` +
        list.map(x => `<div class="shop-row"><label><input type="checkbox"><span>${esc(x.name)}</span></label><b>${x.g >= 1000 ? fmt(x.g / 1000, 2) + ' кг' : fmt(x.g) + ' г'}${x.pcs ? ` <span class="muted">≈ ${x.pcs} шт</span>` : ''}</b></div>`).join('') +
        `<button class="btn full" id="copyShop" style="margin-top:14px">Скопировать список</button>
         <div class="muted" style="margin-top:8px">Вес — в сыром виде, по рецептам рациона.</div>`;
    }
  }
  $('#raBody').addEventListener('click', async e => {
    const days = e.target.closest('[data-days]');
    if (days) { raDays = +days.dataset.days; renderRationSheet(); return; }
    const row = e.target.closest('.shop-row');
    if (row && e.target.matches('input')) { row.classList.toggle('got', e.target.checked); return; }
    const rec = e.target.closest('[data-rrec]');
    if (rec) { openRecipe(raCurrent.meals[+rec.dataset.rrec]); return; }
    if (e.target.closest('#copyShop')) {
      const text = raCurrent.name + ' — список покупок' + (raDays > 1 ? ' на ' + raDays + ' дн.' : '') + ':\n' +
        shoppingList(raCurrent, raDays).map(x => '• ' + x.name + ' — ' + (x.g >= 1000 ? fmt(x.g / 1000, 2) + ' кг' : x.g + ' г')).join('\n');
      try { await navigator.clipboard.writeText(text); toast('Список скопирован'); }
      catch (err) { toast('Не удалось скопировать'); }
    }
  });

  /* ---------- Замеры ---------- */
  let measurePhotos = null;
  const METRIC_KEYS = () => (state.metrics || [['weight', 'Вес', 'кг']]);

  function renderProgress() {
    // вес: замеры + утренний вес из отчётов дня
    const w = (state.weights && state.weights.length ? state.weights : (state.measures || []).filter(m => m.weight)).filter(m => m.weight);
    const chart = $('#weightChart');
    if (w.length < 2) {
      // График строится по дням (за день — последнее взвешивание), поэтому для линии нужны минимум два разных дня
      const one = w.length ? parseDate(w[0].date) : null;
      chart.innerHTML = `<div class="empty">${one
        ? `Пока есть вес только за ${one.getDate()} ${MONTHS[one.getMonth()]}. График появится, когда будет вес ещё за один день — из отчёта (вес утром) или замеров.`
        : 'Вес появится здесь из ежедневных отчётов (вес утром) и воскресных замеров.'}</div>`;
      $('#weightDelta').textContent = '';
    } else {
      const W = 320, H = 170, pad = { l: 30, r: 10, t: 12, b: 22 };
      const vals = w.map(m => m.weight);
      let min = Math.min(...vals), max = Math.max(...vals);
      if (max - min < 2) { min -= 1; max += 1; }
      const x = i => pad.l + i * (W - pad.l - pad.r) / (w.length - 1);
      const y = v => pad.t + (max - v) * (H - pad.t - pad.b) / (max - min);
      const pts = w.map((m, i) => [x(i), y(m.weight)]);
      const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      const area = line + ` L${pts[pts.length - 1][0].toFixed(1)} ${H - pad.b} L${pts[0][0].toFixed(1)} ${H - pad.b} Z`;
      const dm = d => `${parseDate(d).getDate()}.${String(parseDate(d).getMonth() + 1).padStart(2, '0')}`;
      const labels = w.map((m, i) => (w.length <= 6 || i % Math.ceil(w.length / 6) === 0 || i === w.length - 1)
        ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${dm(m.date)}</text>` : '').join('');
      chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <text x="2" y="${pad.t + 4}">${fmt(max, 1)}</text><text x="2" y="${H - pad.b}">${fmt(min, 1)}</text>
        <path class="ar" d="${area}"/><path class="ln" d="${line}"/>
        ${pts.map(p => `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="3.5"/>`).join('')}${labels}</svg>`;
      const d = vals[vals.length - 1] - vals[0];
      $('#weightDelta').innerHTML = `<span class="${d <= 0 ? 'down' : 'up'}">${d > 0 ? '+' : ''}${fmt(d, 1)} кг</span> с ${dm(w[0].date)}`;
    }
    const ms = state.measures || [];
    const last = ms[ms.length - 1], prev = ms[ms.length - 2];
    const delta = k => prev && last[k] != null && prev[k] != null ? last[k] - prev[k] : null;
    $('#lastMeasure').innerHTML = last ? `
      <div class="section-head inner"><h2>Последний замер</h2><span class="muted">${parseDate(last.date).toLocaleDateString('ru-RU')}</span></div>
      <div class="stats7">${METRIC_KEYS().map(([k, n]) => {
        const dd = delta(k);
        return `<div><b>${fmt(last[k], 1)}</b><small>${n.toLowerCase()}${dd != null && dd !== 0 ? ` <span class="${dd < 0 ? 'down' : 'up'}">${dd > 0 ? '+' : ''}${fmt(dd, 1)}</span>` : ''}</small></div>`;
      }).join('')}</div>` : '<h2>Замеров пока нет</h2><div class="muted" style="margin-top:4px">Раз в неделю, по воскресеньям утром.</div>';
    // форма — один раз (чтобы не сбрасывать введённое)
    if (!$('#measureForm').dataset.ready) {
      $('#measureForm').innerHTML = METRIC_KEYS().map(([k, n, u]) => `<label>${n}, ${u}<input name="${k}" inputmode="decimal"${k === 'weight' ? ' required' : ''}></label>`).join('') +
        `<div class="full"><div class="lbl" style="font-size:13px;font-weight:700;margin:6px 0">📸 Фото с 4 сторон <span class="muted" style="font-weight:500">— при хорошем свете</span></div><div class="photos" id="mPhotos"></div></div>
         <button class="btn primary full" type="submit">Сохранить и отправить тренеру</button>`;
      measurePhotos = photoPicker($('#mPhotos'), 4, 'фото');
      $('#measureForm').dataset.ready = '1';
    }
  }

  $('#measureForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = { photos: measurePhotos ? measurePhotos.list : [] };
    METRIC_KEYS().forEach(([k]) => { const v = String(fd.get(k) || '').replace(',', '.').trim(); data[k] = v ? parseFloat(v) : ''; });
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true; btn.textContent = data.photos.length ? 'Отправляю фото…' : 'Сохраняю…';
    try {
      const r = await api('addMeasure', data);
      state.measures = r.measures; if (r.weights) state.weights = r.weights;
      saveCache(); e.target.reset(); measurePhotos && measurePhotos.reset(); renderProgress(); renderResults(); window.scrollTo(0, 0);
      haptic('ok'); toast(r.edited ? 'Сегодняшний замер исправлен ✅' : 'Замеры отправлены тренеру ✅');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Сохранить и отправить тренеру'; }
  });

  /* ---------- Фото (сжатие на телефоне) ---------- */
  // Длинная сторона до 1600 px, JPEG 80% — фото весит ~200–400 КБ вместо 3–5 МБ
  function compress(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть фото')); };
      img.src = url;
    });
  }
  /** Выбор фото в контейнере: возвращает объект с массивом list. labels — подписи пустых ячеек. */
  function photoPicker(box, max, addLabel) {
    const pk = { list: [] };
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.hidden = true;
    box.after(input);
    pk.render = () => {
      box.innerHTML = pk.list.map((src, i) => `<div class="ph"><img src="${src}" alt=""><button type="button" data-rm="${i}" aria-label="Убрать">×</button></div>`).join('') +
        (pk.list.length < max ? `<button type="button" class="add-ph"><b>+</b>${esc(addLabel)}</button>` : '');
    };
    box.addEventListener('click', e => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { pk.list.splice(+rm.dataset.rm, 1); pk.render(); return; }
      if (e.target.closest('.add-ph')) input.click();
    });
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []).slice(0, max - pk.list.length);
      input.value = '';
      for (const f of files) { try { pk.list.push(await compress(f)); } catch (err) { toast(err.message); } }
      pk.render();
    });
    pk.reset = () => { pk.list = []; pk.render(); };
    pk.render();
    return pk;
  }

  /* ---------- Отчёт дня (формат тренера) ---------- */
  let repDay = 'today';
  let repPhotos = null;
  const targetText = t => t ? t.text : '';

  function renderPlan() {
    const m = state.me;
    const cells = [['Калории', m.target ? fmt(m.target) : '—', 'ккал']];
    if (m.tPr) cells.push(['Белок', targetText(m.tPr), 'г']);
    if (m.tFr) cells.push(['Жиры', targetText(m.tFr), 'г']);
    if (m.tCr) cells.push(['Углеводы', targetText(m.tCr), 'г']);
    $('#planCard').innerHTML = `<div class="ttl">Ваша планка на день</div>` + cells.map(c => `<div><b>${esc(c[1])}</b><small>${c[0]}${c[1] !== '—' ? ', ' + c[2] : ''}</small></div>`).join('');
  }

  function dayReport() { return (state.daily || {})[repDay] || null; }

  function renderReport() {
    renderPlan();
    const r = dayReport();
    const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
    const tDate = parseDate(state.date), yDate = parseDate(state.date); yDate.setDate(yDate.getDate() - 1);
    const dDate = repDay === 'yesterday' ? yDate : tDate;
    const label = `${dDate.getDate()} ${MONTHS[dDate.getMonth()]}`;
    const yLabel = `${yDate.getDate()} ${MONTHS[yDate.getMonth()]}`;
    // Плашка «за вчера» — только если вчерашний отчёт не сдан и человек уже участвовал вчера (не стартовал сегодня)
    const yMissing = !(state.daily || {}).yesterday && !(state.me.start && state.me.start >= state.date);
    // Заголовок с датой: за какой день этот отчёт. «Вчера» показывается, только если вчерашний отчёт не сдан
    $('#repDay').innerHTML = repDay === 'today'
      ? (yMissing ? `<button class="late" id="goYesterday">⚠️ <span>За вчера, <b>${yLabel}</b>, отчёт не сдан</span><span class="go">Заполнить →</span></button>` : '') +
        `<div class="rep-head"><div class="t">Отчёт за <span>сегодня</span>, ${WD[dDate.getDay()]} ${label}</div><div class="s">Отправьте до 0:00</div></div>`
      : `<div class="rep-head"><div class="t">Отчёт за <span>вчера</span>, ${WD[dDate.getDay()]} ${label}</div>
          <div class="s">Опоздавший отчёт запишется на ${label}</div><button class="back" id="goToday">← к отчёту за сегодня</button></div>`;
    $('#repStatus').innerHTML = r
      ? `<div class="rep-status ok">✓ Отчёт за ${label} отправлен${r.sentAt ? ' в ' + esc(r.sentAt) : ''}. Можно исправить и отправить заново.</div>`
      : '';
    const v = r || {};
    const val = k => { const x = v[k]; return x == null || x === '' ? '' : String(x).replace('.', ','); };
    const hunger = v.hunger || '';
    $('#reportForm').innerHTML = `
      <div class="fld"><div class="lbl">📎 Дневник FatSecret <small>ссылка на экспорт</small></div>
        <input name="fatsecret" type="text" inputmode="url" value="${esc(v.fatsecret || '')}" placeholder="Вставьте ссылку из FatSecret" autocomplete="off">
        <div id="fsBox"></div></div>
      <div id="manualKbju">
        <div class="fs-or">Нет ссылки? Введите вручную и приложите скриншоты</div>
        <div class="fld"><div class="lbl">🔥 Калории за день</div>
          <input name="kcal" inputmode="numeric" placeholder="например, 1650" value="${val('kcal')}"></div>
        <div class="fld"><div class="lbl">БЖУ, г <small>белок — обязательно, если тренер выдал планку</small></div>
          <div class="row3">
            <label>Белки<input name="p" inputmode="decimal" value="${val('p')}"></label>
            <label>Жиры<input name="f" inputmode="decimal" value="${val('f')}"></label>
            <label>Углеводы<input name="c" inputmode="decimal" value="${val('c')}"></label>
          </div></div>
        <div class="fld"><div class="lbl">📷 Скриншоты FatSecret <small>до 3</small></div>
          <div class="photos" id="repPhotos"></div></div>
      </div>
      <div class="fld"><div class="lbl">😋 Голод в течение дня</div>
        <div class="scale" id="hungerScale">${Array.from({ length: 10 }, (_, i) => `<button type="button" data-h="${i + 1}" class="${+hunger === i + 1 ? 'on' : ''}">${i + 1}</button>`).join('')}</div>
        <div class="scale-hint"><span>не голоден</span><span>очень голоден</span></div>
        <input type="hidden" name="hunger" value="${esc(hunger)}"></div>
      <div class="fld"><div class="row2">
        <label>⚖️ Вес утром, кг<input name="weight" inputmode="decimal" value="${val('weight')}" placeholder="натощак"></label>
        <label>💧 Вода, л<input name="water" inputmode="decimal" value="${val('water')}" placeholder="примерно"></label>
      </div></div>
      <div class="fld"><div class="row2">
        <label>👣 Шаги<input name="steps" inputmode="numeric" value="${val('steps')}"></label>
        <label>☕ Чай/кофе, кружек<input name="tea" inputmode="numeric" value="${val('tea')}" placeholder="без добавок"></label>
      </div>
        <label class="toggle"><input type="checkbox" name="stepsTr" ${v.stepsTr === 'с тренировкой' ? 'checked' : ''}> шаги с учётом тренировки</label></div>
      <div class="fld"><div class="row2">
        <label>🏋️ Тренировка<input name="training" value="${esc(v.training || '')}" placeholder="нет / силовая 60 мин"></label>
        <label>🥦 Растительность, г<input name="veg" inputmode="numeric" value="${val('veg')}" placeholder="овощи и фрукты"></label>
      </div></div>
      <div class="fld"><div class="lbl">💬 Комментарий для тренера</div>
        <textarea name="note" class="grow" rows="3" placeholder="необязательно">${esc(v.note || '')}</textarea></div>
      <button class="btn primary full" type="submit">${r ? 'Отправить исправленный отчёт' : 'Отправить отчёт за ' + (repDay === 'today' ? 'сегодня' : 'вчера, ' + label)}</button>`;
    repPhotos = photoPicker($('#repPhotos'), 3, 'скриншот');
    fsData = null;
    if (v.fatsecret) checkFs(v.fatsecret); else showManual(true);
  }

  /* ---------- FatSecret: цифры дня по ссылке экспорта ---------- */
  let fsData = null, fsTimer = null, fsReq = 0;
  const showManual = on => { const m = $('#manualKbju'); if (m) m.classList.toggle('hidden', !on); };
  function fsCard(fs) {
    const d = parseDate(fs.date);
    const meals = (fs.meals || []).map(m => `<div class="fs-meal"><div class="fs-mt"><span>${esc(m.meal)}</span><span>${fmt(m.kcal)} ккал</span></div>
      ${m.items.map(x => `<div class="fs-it"><span>${esc(x.name)}${x.amount ? ` <i>${esc(x.amount)}</i>` : ''}</span><span>${fmt(x.kcal)}</span></div>`).join('')}</div>`).join('');
    return `<div class="fs-card"><div class="fs-top">✓ Загружено из FatSecret · ${d.getDate()} ${MONTHS[d.getMonth()]}</div>
      <div class="fs-nums"><div><b>${fmt(fs.kcal)}</b><span>ккал</span></div><div><b>${fmt(fs.p)}</b><span>белки</span></div>
      <div><b>${fmt(fs.f)}</b><span>жиры</span></div><div><b>${fmt(fs.c)}</b><span>углеводы</span></div></div>
      ${meals ? `<details><summary>Что съедено</summary>${meals}</details>` : ''}</div>`;
  }
  async function checkFs(url) {
    const box = $('#fsBox');
    url = String(url || '').trim();
    fsData = null;
    const id = ++fsReq;
    if (!url) { box.innerHTML = ''; showManual(true); return; }
    if (!/fatsecret\./i.test(url)) { box.innerHTML = '<div class="fs-err">Это не ссылка FatSecret. В приложении FatSecret: Дневник → Экспорт → скопировать ссылку.</div>'; showManual(true); return; }
    box.innerHTML = '<div class="fs-load">Загружаю дневник из FatSecret…</div>';
    showManual(false);
    try {
      const r = await api('fatsecret', { url, day: repDay });
      if (id !== fsReq) return;
      fsData = r.fs;
      box.innerHTML = fsCard(r.fs);
      haptic();
    } catch (err) {
      if (id !== fsReq) return;
      box.innerHTML = `<div class="fs-err">${esc(err.message)}</div>`;
      showManual(true);
    }
  }
  $('#reportForm').addEventListener('input', e => {
    if (e.target.name !== 'fatsecret') return;
    clearTimeout(fsTimer);
    fsTimer = setTimeout(() => checkFs(e.target.value), 600);
  });

  $('#repDay').addEventListener('click', e => {
    if (e.target.closest('#goYesterday')) repDay = 'yesterday';
    else if (e.target.closest('#goToday')) repDay = 'today';
    else return;
    renderReport(); window.scrollTo(0, 0); haptic();
  });
  $('#reportForm').addEventListener('click', e => {
    const h = e.target.closest('[data-h]');
    if (h) {
      $('#reportForm [name=hunger]').value = h.dataset.h;
      $$('#hungerScale button').forEach(x => x.classList.toggle('on', x === h)); haptic(); return;
    }
  });
  $('#reportForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = { day: repDay, photos: repPhotos ? repPhotos.list : [] };
    ['kcal', 'p', 'f', 'c', 'hunger', 'weight', 'water', 'steps', 'tea', 'veg'].forEach(k => { data[k] = String(fd.get(k) || '').replace(',', '.').replace(/\s/g, ''); });
    ['training', 'fatsecret', 'note'].forEach(k => { data[k] = String(fd.get(k) || '').trim(); });
    data.stepsTr = !!fd.get('stepsTr');
    if (fsData) { data.kcal = String(fsData.kcal); data.p = fsData.p == null ? '' : String(fsData.p); data.f = fsData.f == null ? '' : String(fsData.f); data.c = fsData.c == null ? '' : String(fsData.c); data.photos = []; }
    if (!(parseFloat(data.kcal) > 0)) { toast(data.fatsecret ? 'Ссылка FatSecret не подошла — введите калории вручную' : 'Вставьте ссылку FatSecret или укажите калории'); return; }
    if (state.me.tPr && !data.p && !(await confirmAsk('Белок не указан. Отправить без него?'))) return;
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true; btn.textContent = data.photos.length ? 'Отправляю со скриншотами…' : 'Отправляю…';
    try {
      const r = await api('saveReport', data);
      state.daily = state.daily || {};
      state.daily[repDay] = r.report;
      if (r.weights) state.weights = r.weights;
      if (repDay === 'yesterday') repDay = 'today';
      upsertHistory(r.report);
      saveCache(); renderReport(); renderProgress(); renderResults(); window.scrollTo(0, 0);
      haptic('ok'); toast(r.delivered === false ? 'Отчёт сохранён в таблицу' : 'Отчёт отправлен тренеру ✅');
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Отправить отчёт тренеру'; }
  });

  /* ---------- Вкладки ---------- */
  function switchTab(name) {
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    window.scrollTo(0, 0);
  }
  $$('.tabs button').forEach(b => b.addEventListener('click', () => { switchTab(b.dataset.tab); haptic(); }));

  // Ссылка вида …/#menu открывает нужную вкладку (так бот может вести сразу в меню)
  function openFromHash() {
    const h = (location.hash || '').slice(1) || (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
    // старые ссылки (#today, #add) ведут на отчёт
    const tab = h === 'today' || h === 'add' ? 'report' : h === 'rations' ? 'menu' : h;
    if (['report', 'results', 'menu', 'progress'].includes(tab)) switchTab(tab);
  }

  /* ---------- Обучение: что за что отвечает (5 шагов, показывается один раз) ---------- */
  const TOUR_KEY = 'nutrition-tour-v1-' + tgUserId;
  const TOUR = [
    { ic: '👋', t: 'Привет!', x: 'Покажу за 15 секунд, где что лежит.' },
    { tab: 'report', ic: '📝', t: 'Отчёт', x: 'Каждый день до 0:00. Калории и белок — из FatSecret, плюс голод, вес и шаги.' },
    { tab: 'menu', ic: '📋', t: 'Меню', x: 'Меню на неделю от тренера и рецепты.' },
    { tab: 'progress', ic: '📏', t: 'Замеры', x: 'По воскресеньям: замеры и 4 фото.' },
    { tab: 'results', ic: '📊', t: 'Итоги', x: 'Ваш прогресс: вес, калории и белок по дням.' },
    { ic: '🔔', t: 'Напоминания придут в чат', x: 'Бот напомнит об отчёте и замерах — кнопка в сообщении откроет нужный экран.' }
  ];
  let tourStep = 0;
  function tourSeen() { try { return !!localStorage.getItem(TOUR_KEY); } catch (e) { return true; } }
  function startTour() {
    tourStep = 0;
    closeSheets();
    $('#tour').classList.toggle('hidden', false);
    $('#tourDots').innerHTML = TOUR.map(() => '<i></i>').join('');
    showTourStep();
  }
  function endTour() {
    $('#tour').classList.add('hidden');
    try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) {}
    switchTab('report');
  }
  function showTourStep() {
    const s = TOUR[tourStep], spot = $('#tourSpot'), card = $('#tourCard');
    $('#tourIc').textContent = s.ic; $('#tourT').textContent = s.t; $('#tourX').textContent = s.x;
    $$('#tourDots i').forEach((d, i) => d.classList.toggle('on', i === tourStep));
    $('#tourNext').textContent = tourStep === TOUR.length - 1 ? 'Понятно 👍' : 'Далее';
    $('#tourSkip').style.visibility = tourStep === TOUR.length - 1 ? 'hidden' : '';
    const btn = s.tab && $(`.tabs button[data-tab="${s.tab}"]`);
    if (btn) {
      switchTab(s.tab); // за подсветкой видно, что на этой вкладке
      const r = btn.getBoundingClientRect();
      Object.assign(spot.style, { left: (r.left - 4) + 'px', top: (r.top - 4) + 'px', width: (r.width + 8) + 'px', height: (r.height + 8) + 'px' });
      spot.classList.toggle('center', false);
      card.style.top = ''; card.style.bottom = (window.innerHeight - r.top + 14) + 'px';
    } else {
      spot.classList.add('center');
      card.style.bottom = ''; card.style.top = '30%';
    }
    haptic();
  }
  $('#tourNext').addEventListener('click', () => { if (++tourStep >= TOUR.length) endTour(); else showTourStep(); });
  $('#tourSkip').addEventListener('click', endTour);
  $('#helpBtn').addEventListener('click', startTour);
  window.addEventListener('resize', () => { if (!$('#tour').classList.contains('hidden')) showTourStep(); });

  init();
})();
