/* Дневник питания — Telegram Mini App. Данные: Google Apps Script API (config.js). */
(function () {
  'use strict';

  const tg = window.Telegram && Telegram.WebApp;
  const inTelegram = !!(tg && tg.initData);
  const API = window.APP_CONFIG.api;
  const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const CACHE_KEY = 'nutrition-app-v1';

  let state = null;          // ответ init
  let items = [];            // справочник [{name, type, kcal, p, f, c, portion}]
  let menuDay = 0;
  let current = null;        // выбранный продукт в окне количества
  let unit = 'г';
  let filter = 'all';

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
    document.documentElement.dataset.theme = tg.colorScheme || 'light';
    tg.onEvent('themeChanged', () => { document.documentElement.dataset.theme = tg.colorScheme; });
    try { tg.setHeaderColor('secondary_bg_color'); } catch (e) {}
  }

  /* ---------- API ---------- */
  let pending = 0;
  async function api(action, data = {}) {
    pending++; $('#sync').classList.add('busy');
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, initData: inTelegram ? tg.initData : '', demo: !inTelegram }, data))
      });
      const json = await res.json();
      if (json.error) throw Object.assign(new Error(json.message || json.error), { code: json.error });
      return json;
    } finally {
      if (--pending === 0) $('#sync').classList.remove('busy');
    }
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

  async function init() {
    const cached = loadCache();
    if (cached) apply(cached); else skeleton();
    try {
      apply(await api('init'));
      saveCache();
      openFromHash();
    } catch (e) {
      if (!state) showError(e);
      else toast('Нет связи с таблицей, показаны сохранённые данные');
    }
  }

  function skeleton() {
    $('#todayList').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  }

  function showError(e) {
    const msgs = {
      not_registered: ['🙋', 'Вас пока нет в группе', e.message],
      unauthorized: ['🔒', 'Не удалось войти', e.message],
      finished: ['👋', 'Участие завершено', e.message],
      no_demo: ['📱', 'Откройте из Telegram', e.message]
    };
    const [icon, title, text] = msgs[e.code] || ['⚠️', 'Ошибка загрузки', 'Проверьте интернет и попробуйте снова. ' + (e.message || '')];
    $('main').innerHTML = `<div class="error-box"><div class="big">${icon}</div><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
      <button class="btn" onclick="location.reload()">Обновить</button></div>`;
    $('#fab').classList.add('hidden');
    $('.tabs').classList.add('hidden');
    $('#sub').textContent = '';
  }

  function apply(data) {
    state = data;
    items = (data.items || []).map(a => ({ name: a[0], type: a[1], kcal: a[2], p: a[3], f: a[4], c: a[5], portion: a[6] || 0 }));
    const d = parseDate(data.date);
    $('#hello').textContent = 'Привет, ' + data.me.name + '!';
    $('#sub').textContent = `${DAYS[(d.getDay() + 6) % 7]}, ${d.getDate()} ${MONTHS[d.getMonth()]}` + (data.me.target ? ` · цель ${fmt(data.me.target)} ккал` : '');
    $('#demoBanner').classList.toggle('hidden', !data.demo);
    renderToday(); renderHistory(); renderMenu(); renderProgress(); renderReports();
  }

  /* ---------- Сегодня ---------- */
  function renderToday() {
    const t = state.today, target = state.me.target || 0;
    const ratio = target ? t.kcal / target : 0;
    const ring = $('#ringFg');
    const C = 2 * Math.PI * 52; // длина окружности кольца
    ring.style.strokeDasharray = C.toFixed(1) + 'px';
    ring.style.strokeDashoffset = (C * (1 - Math.min(ratio, 1))).toFixed(1) + 'px';
    ring.style.stroke = ratio > 1.15 ? 'var(--bad)' : ratio > 1 ? 'var(--warn)' : 'var(--accent)';
    $('#kcalNum').textContent = fmt(t.kcal);
    $('#kcalCap').textContent = target ? 'из ' + fmt(target) + ' ккал' : 'ккал';
    $('#leftLabel').textContent = !target ? '' : t.kcal <= target ? `Осталось ${fmt(target - t.kcal)} ккал` : `Сверх цели +${fmt(t.kcal - target)} ккал`;
    const kcalOf = { p: 4, f: 9, c: 4 };
    const total = Math.max(1, t.p * 4 + t.f * 9 + t.c * 4);
    $('#macros').innerHTML = [['p', 'Белки'], ['f', 'Жиры'], ['c', 'Углеводы']].map(([k, n]) =>
      `<div class="macro"><div class="macro-top"><span>${n}</span><b>${fmt(t[k], 0)} г</b></div>
       <div class="bar"><i style="width:${Math.round(t[k] * kcalOf[k] / total * 100)}%;background:var(--${k})"></i></div></div>`).join('');

    const list = $('#todayList');
    if (!t.items.length) {
      list.innerHTML = '<div class="empty">Пока пусто. Нажмите «+», чтобы добавить первый приём пищи.</div>';
      return;
    }
    list.innerHTML = t.items.map((it, i) => `
      <div class="item">
        <div><div class="name">${esc(it.name)}</div>
        <div class="meta">${fmt(it.qty, 2)} ${esc(it.unit || '')}${it.unit && it.unit !== 'г' && it.grams ? ' · ' + fmt(it.grams) + ' г' : ''} · Б ${fmt(it.p, 1)} Ж ${fmt(it.f, 1)} У ${fmt(it.c, 1)}</div></div>
        <div class="kcal">${fmt(it.kcal)}</div>
        <button class="del" data-del="${i}" aria-label="Удалить">×</button>
      </div>`).join('');
  }

  $('#todayList').addEventListener('click', async e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    const it = state.today.items[+b.dataset.del];
    const ok = await confirmAsk(`Удалить «${it.name}» из дневника?`); if (!ok) return;
    b.closest('.item').style.opacity = .4;
    try {
      const r = await api('deleteFood', { row: it.row, name: it.name });
      state.today = r.today; updateTodayHistory(); renderToday(); renderHistory(); saveCache(); haptic('ok');
    } catch (err) { toast(err.message); renderToday(); }
  });

  function confirmAsk(text) {
    return new Promise(res => tg && tg.showConfirm && inTelegram ? tg.showConfirm(text, res) : res(window.confirm(text)));
  }

  function updateTodayHistory() {
    const h = state.history.find(x => x.date === state.date);
    if (h) h.kcal = Math.round(state.today.kcal);
  }

  const PLOT_H = 86, LABEL_H = 18; // высота столбиков и подписи дат, px
  function renderHistory() {
    const h = state.history || [], target = state.me.target || 0;
    const max = Math.max(target * 1.2, ...h.map(x => x.kcal), 1);
    $('#historyBars').innerHTML = h.map(x => {
      const d = parseDate(x.date);
      const cls = !x.kcal ? 'zero' : target && x.kcal > target * 1.1 ? 'over' : '';
      return `<div class="b" title="${d.getDate()}.${d.getMonth() + 1}: ${x.kcal} ккал"><i class="${cls}" style="height:${Math.max(2, Math.round(x.kcal / max * PLOT_H))}px"></i><span>${d.getDate()}</span></div>`;
    }).join('') + (target ? `<div class="target" style="bottom:${LABEL_H + Math.round(target / max * PLOT_H)}px" title="Цель ${target} ккал"></div>` : '');
  }

  /* ---------- Добавление ---------- */
  function openSheet(id) {
    $$('.sheet').forEach(s => s.classList.add('hidden'));
    $(id).classList.remove('hidden');
    if (tg && tg.BackButton) { tg.BackButton.show(); }
  }
  function closeSheets() {
    $$('.sheet').forEach(s => s.classList.add('hidden'));
    if (tg && tg.BackButton) tg.BackButton.hide();
  }
  if (tg && tg.BackButton) tg.BackButton.onClick(closeSheets);
  $$('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
  $$('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s) closeSheets(); }));

  function openAdd() {
    openSheet('#addSheet');
    $('#search').value = '';
    renderResults();
    setTimeout(() => $('#search').focus(), 250);
  }
  $('#fab').addEventListener('click', openAdd);
  $('#addBtnTop').addEventListener('click', openAdd);
  $('#search').addEventListener('input', renderResults);
  $('#filters').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    filter = b.dataset.f;
    $$('#filters button').forEach(x => x.classList.toggle('on', x === b));
    renderResults();
  });

  function renderResults() {
    const q = norm($('#search').value.trim());
    const words = q.split(/\s+/).filter(Boolean);
    let list = items.filter(it => (filter === 'all' || it.type === filter) && words.every(w => norm(it.name).includes(w)));
    list.sort((a, b) => (norm(b.name).startsWith(q) - norm(a.name).startsWith(q)) || (a.type === 'r' ? -1 : 0) - (b.type === 'r' ? -1 : 0) || a.name.localeCompare(b.name, 'ru'));
    $('#results').innerHTML = list.slice(0, 80).map(it => `
      <button class="res" data-name="${esc(it.name)}">
        <div><div>${esc(it.name)}${it.type === 'r' ? '<span class="tag">рецепт</span>' : ''}</div>
        <div class="meta">${it.type === 'r' && it.portion ? `порция ${fmt(it.portion)} г · ${fmt(it.kcal * it.portion / 100)} ккал` : `на 100 г · Б ${fmt(it.p, 1)} Ж ${fmt(it.f, 1)} У ${fmt(it.c, 1)}`}</div></div>
        <div class="k">${it.type === 'r' && it.portion ? '' : fmt(it.kcal) + ' ккал'}</div>
      </button>`).join('') || '<div class="empty">Ничего не нашлось. Попросите тренера добавить продукт в справочник.</div>';
  }

  $('#results').addEventListener('click', e => {
    const b = e.target.closest('.res'); if (!b) return;
    openQty(items.find(x => x.name === b.dataset.name));
  });

  function openQty(it, qty, u) {
    current = it;
    const units = ['г'].concat(it.portion ? [it.type === 'r' ? 'порц' : 'шт'] : []);
    unit = u && units.includes(u) ? u : (it.type === 'r' && it.portion ? 'порц' : 'г');
    $('#qTitle').textContent = it.name;
    $('#qPer').textContent = `100 г: ${fmt(it.kcal)} ккал · Б ${fmt(it.p, 1)} Ж ${fmt(it.f, 1)} У ${fmt(it.c, 1)}` + (it.portion ? ` · ${it.type === 'r' ? 'порция' : '1 шт'} ≈ ${fmt(it.portion)} г` : '');
    $('#units').innerHTML = units.map(x => `<button data-u="${x}" class="${x === unit ? 'on' : ''}">${x === 'г' ? 'граммы' : x === 'шт' ? 'штуки' : 'порции'}</button>`).join('');
    $('#qty').value = qty != null ? qty : unit === 'г' ? 100 : 1;
    renderQuick(); updatePreview();
    openSheet('#qtySheet');
  }

  $('#units').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    unit = b.dataset.u;
    $$('#units button').forEach(x => x.classList.toggle('on', x === b));
    $('#qty').value = unit === 'г' ? 100 : 1;
    renderQuick(); updatePreview();
  });
  function renderQuick() {
    const vals = unit === 'г' ? [50, 100, 150, 200, 250, 300] : [0.5, 1, 1.5, 2, 3];
    $('#quick').innerHTML = vals.map(v => `<button data-q="${v}">${fmt(v, 1)} ${unit}</button>`).join('');
  }
  $('#quick').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $('#qty').value = b.dataset.q; updatePreview(); haptic(); });
  $$('.step').forEach(b => b.addEventListener('click', () => {
    const step = unit === 'г' ? 10 : 0.5;
    const v = Math.max(0, (parseFloat(String($('#qty').value).replace(',', '.')) || 0) + step * +b.dataset.step);
    $('#qty').value = Math.round(v * 10) / 10; updatePreview(); haptic();
  }));
  $('#qty').addEventListener('input', updatePreview);

  function calc(it, qty, u) {
    const grams = u === 'г' ? qty : qty * (it.portion || 0);
    const k = grams / 100;
    return { grams, kcal: it.kcal * k, p: it.p * k, f: it.f * k, c: it.c * k };
  }
  function updatePreview() {
    const qty = parseFloat(String($('#qty').value).replace(',', '.')) || 0;
    const n = calc(current, qty, unit);
    $('#preview').innerHTML = `<div><b>${fmt(n.kcal)}</b><small>ккал</small></div><div><b>${fmt(n.p, 1)}</b><small>белки</small></div>
      <div><b>${fmt(n.f, 1)}</b><small>жиры</small></div><div><b>${fmt(n.c, 1)}</b><small>углеводы</small></div>`;
    $('#addConfirm').disabled = !(qty > 0);
  }

  $('#addConfirm').addEventListener('click', async () => {
    const qty = parseFloat(String($('#qty').value).replace(',', '.'));
    if (!(qty > 0)) return;
    const btn = $('#addConfirm');
    btn.disabled = true; btn.textContent = 'Сохраняю…';
    try {
      const r = await api('addFood', { item: current.name, qty, unit });
      state.today = r.today; updateTodayHistory(); saveCache();
      closeSheets(); switchTab('today'); renderToday(); renderHistory();
      haptic('ok'); toast('Добавлено: ' + current.name);
    } catch (e) { toast(e.message); }
    finally { btn.disabled = false; btn.textContent = 'Добавить в дневник'; }
  });

  /* ---------- Меню ---------- */
  function renderMenu() {
    const m = state.menu;
    if (!m) {
      $('#menuHead').innerHTML = '<div class="title">Меню пока не назначено</div><div class="muted">Тренер пришлёт его в бот, и оно появится здесь.</div>';
      $('#dayChips').innerHTML = ''; $('#dayMeals').innerHTML = '';
      return;
    }
    $('#menuHead').innerHTML = `<div class="code">${esc(m.code)}</div><div class="title">${esc(m.name || 'Меню на неделю')}</div><div class="muted">Неделя ${esc(m.period)}${m.target ? ' · ' + fmt(m.target) + ' ккал в день' : ''}</div>`;
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
          <div class="row">
            ${state.recipes && state.recipes[x.item] ? `<button class="link" data-recipe="${i}">Рецепт →</button>` : '<span></span>'}
            <button class="btn" data-eat="${i}">Съел(а) ✓</button>
          </div>
        </div>`).join('') : '<div class="empty">На этот день блюд нет</div>');
  }
  $('#dayChips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; menuDay = +b.dataset.d; renderMenu(); haptic(); });
  $('#dayMeals').addEventListener('click', e => {
    const day = state.menu.days[menuDay];
    const eat = e.target.closest('[data-eat]');
    if (eat) {
      const x = day.meals[+eat.dataset.eat];
      const it = items.find(i => i.name === x.item);
      if (it) openQty(it, x.qty, x.unit || (it.type === 'r' ? 'порц' : 'г'));
      return;
    }
    const rb = e.target.closest('[data-recipe]');
    if (rb) openRecipe(day.meals[+rb.dataset.recipe]);
  });

  function openRecipe(x) {
    const r = state.recipes[x.item];
    const it = items.find(i => i.name === x.item);
    // во сколько раз ингредиентов меньше/больше, чем в целом рецепте, при этой порции
    const portions = x.unit === 'г' && r.portion ? x.qty / r.portion : Number(x.qty) || 1;
    const k = portions / (r.portions || 1);
    $('#rTitle').textContent = x.item;
    $('#rBody').innerHTML = `
      <div class="muted">На вашу порцию (${fmt(x.qty, 2)} ${esc(x.unit)})${it ? ' · ' + fmt(x.kcal) + ' ккал' : ''}</div>
      <div style="margin-top:8px">${r.items.map(([n, g]) => `<div class="ing"><span>${esc(n)}</span><b>${fmt(g * k)} г</b></div>`).join('')}</div>
      ${r.desc ? `<p class="desc">${esc(r.desc)}</p>` : ''}
      <div class="muted" style="margin:10px 0 14px">Весь рецепт: ${r.portions} порц.; граммы — в сыром виде.</div>
      <button class="btn primary full" id="rEat">Съел(а) — записать в дневник</button>`;
    $('#rEat').onclick = () => { if (it) openQty(it, x.qty, x.unit); };
    openSheet('#recipeSheet');
  }

  /* ---------- Прогресс ---------- */
  function renderProgress() {
    const ms = state.measures || [];
    const w = ms.filter(m => m.weight);
    const chart = $('#weightChart');
    if (w.length < 2) {
      chart.innerHTML = `<div class="empty">${w.length ? 'Нужен ещё хотя бы один замер, чтобы построить график' : 'Замеров пока нет — внесите первый ниже'}</div>`;
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
      const labels = w.map((m, i) => (w.length <= 6 || i % Math.ceil(w.length / 6) === 0 || i === w.length - 1)
        ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${parseDate(m.date).getDate()}.${String(parseDate(m.date).getMonth() + 1).padStart(2, '0')}</text>` : '').join('');
      chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <text x="2" y="${pad.t + 4}">${fmt(max, 1)}</text><text x="2" y="${H - pad.b}">${fmt(min, 1)}</text>
        <path class="ar" d="${area}"/><path class="ln" d="${line}"/>
        ${pts.map(p => `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="3.5"/>`).join('')}${labels}</svg>`;
      const d = vals[vals.length - 1] - vals[0];
      $('#weightDelta').innerHTML = `<span class="${d <= 0 ? 'down' : 'up'}">${d > 0 ? '+' : ''}${fmt(d, 1)} кг</span> с ${parseDate(w[0].date).getDate()}.${String(parseDate(w[0].date).getMonth() + 1).padStart(2, '0')}`;
    }
    const last = ms[ms.length - 1], prev = ms[ms.length - 2];
    const delta = k => prev && last[k] != null && prev[k] != null ? last[k] - prev[k] : null;
    $('#lastMeasure').innerHTML = last ? `
      <div class="section-head inner"><h2>Последний замер</h2><span class="muted">${parseDate(last.date).toLocaleDateString('ru-RU')}</span></div>
      <div class="stats">${[['weight', 'вес'], ['chest', 'грудь'], ['waist', 'талия'], ['hips', 'бёдра']].map(([k, n]) => {
        const dd = delta(k);
        return `<div><b>${fmt(last[k], 1)}</b><small>${n}${dd != null && dd !== 0 ? ` <span class="${dd < 0 ? 'down' : 'up'}">${dd > 0 ? '+' : ''}${fmt(dd, 1)}</span>` : ''}</small></div>`;
      }).join('')}</div>` : '<h2>Замеров пока нет</h2><div class="muted" style="margin-top:4px">Раз в неделю: утром натощак, до тренировки.</div>';
  }

  $('#measureForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {}; ['weight', 'chest', 'waist', 'hips'].forEach(k => { const v = String(fd.get(k) || '').replace(',', '.').trim(); data[k] = v ? parseFloat(v) : ''; });
    const btn = $('button', e.target);
    btn.disabled = true; btn.textContent = 'Сохраняю…';
    try {
      const r = await api('addMeasure', data);
      state.measures = r.measures; saveCache(); renderProgress(); e.target.reset(); haptic('ok'); toast('Замер сохранён');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Сохранить замер'; }
  });

  /* ---------- Отчёт тренеру ---------- */
  const MAX_PHOTOS = 5;
  let photos = []; // dataURL сжатых JPEG

  function renderPhotos() {
    $('#photos').innerHTML = photos.map((src, i) => `<div class="ph"><img src="${src}" alt=""><button data-rm="${i}" aria-label="Убрать">×</button></div>`).join('') +
      (photos.length < MAX_PHOTOS ? `<button class="add-ph" id="addPhoto"><b>+</b>${photos.length ? 'Ещё фото' : 'Добавить фото'}</button>` : '');
  }
  $('#photos').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { photos.splice(+rm.dataset.rm, 1); renderPhotos(); return; }
    if (e.target.closest('#addPhoto')) $('#photoInput').click();
  });

  // Сжимаем на телефоне: длинная сторона до 1600 px, JPEG 80% — фото весит ~200–400 КБ вместо 3–5 МБ
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
  $('#photoInput').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []).slice(0, MAX_PHOTOS - photos.length);
    e.target.value = '';
    for (const f of files) {
      try { photos.push(await compress(f)); } catch (err) { toast(err.message); }
    }
    if ((e.target.files || []).length > files.length) toast('Не больше ' + MAX_PHOTOS + ' фото за раз');
    renderPhotos();
  });

  $('#sendReport').addEventListener('click', async () => {
    const text = $('#reportText').value.trim();
    if (!photos.length && !text) { toast('Добавьте фото или напишите комментарий'); return; }
    const btn = $('#sendReport');
    btn.disabled = true; btn.textContent = photos.length ? 'Отправляю фото…' : 'Отправляю…';
    try {
      const r = await api('report', { text, photos });
      state.reports = r.reports; saveCache();
      photos = []; $('#reportText').value = '';
      renderPhotos(); renderReports(); haptic('ok'); toast('Отчёт отправлен тренеру ✅');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Отправить тренеру'; }
  });

  function renderReports() {
    renderPhotos();
    const list = state.reports || [];
    $('#reportList').innerHTML = list.length ? list.map(r => {
      const d = parseDate(r.date);
      const isPhoto = /фото/.test(r.type);
      return `<div class="item rep"><div class="ic">${isPhoto ? '📸' : '💬'}</div>
        <div><div class="name">${d.getDate()} ${MONTHS[d.getMonth()]}, ${esc(r.time)}</div>
        <div class="meta">${esc(r.text && r.text !== '[фото]' ? r.text : r.type)}</div></div></div>`;
    }).join('') : '<div class="empty">Отчётов пока нет</div>';
  }

  /* ---------- Вкладки ---------- */
  function switchTab(name) {
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    $('#fab').classList.toggle('hidden', name === 'progress' || name === 'report');
    window.scrollTo(0, 0);
  }
  $$('.tabs button').forEach(b => b.addEventListener('click', () => { switchTab(b.dataset.tab); haptic(); }));

  // Ссылка вида …/#menu открывает нужную вкладку (так бот может вести сразу в меню)
  function openFromHash() {
    const h = (location.hash || '').slice(1) || (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
    if (['today', 'menu', 'progress', 'report'].includes(h)) switchTab(h);
    if (h === 'add') openAdd();
  }

  init();
})();
