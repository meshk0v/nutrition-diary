/* Админка тренера — Telegram Mini App. Данные: тот же Google Apps Script API (config.js), действия «adm_…». */
(function () {
  'use strict';

  const tg = window.Telegram && Telegram.WebApp;
  const API = window.APP_CONFIG.api;
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  let S = null;              // ответ adm_init
  const UNIT_WORD = { 'г': 'грамм', 'шт': 'штук', 'порц': 'порций' };
  const DAY_WORD = { 'Пн': 'понедельник', 'Вт': 'вторник', 'Ср': 'среда', 'Чт': 'четверг', 'Пт': 'пятница', 'Сб': 'суббота', 'Вс': 'воскресенье' };
  let items = [];            // [{name, type, kcal, p, f, c, portion}]
  let ed = null;             // редактор: {menu, day}
  let statFilter = 'all';
  let row = null;            // строка в панели: {mode: 'edit'|'add', r, meal, unit}
  let confirmFn = null;

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n, d = 0) => n == null || n === '' ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: d });
  const norm = s => String(s).toLowerCase().replace(/ё/g, 'е');
  const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(n) ? null : n; };
  const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const dayLabel = s => { const d = parseDate(s); return d.getDate() + ' ' + MONTHS[d.getMonth()]; };
  const ddmm = s => { const d = parseDate(s); return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0'); };
  const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const haptic = t => { try { tg && tg.HapticFeedback && (t === 'ok' ? tg.HapticFeedback.notificationOccurred('success') : tg.HapticFeedback.impactOccurred('light')); } catch (e) {} };

  /* ---------- Telegram ---------- */
  if (tg) {
    tg.ready();
    tg.expand();
    try { if (tg.requestFullscreen && /^(android|android_x|ios)$/.test(tg.platform || '') && !tg.isFullscreen) tg.requestFullscreen(); } catch (e) {}
    document.documentElement.dataset.theme = tg.colorScheme || 'light';
    tg.onEvent('themeChanged', () => { document.documentElement.dataset.theme = tg.colorScheme; });
    try { tg.setHeaderColor('secondary_bg_color'); } catch (e) {}
    try { if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); } catch (e) {}
  }

  /* ---------- API ---------- */
  async function api(action, data = {}) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, initData: tg ? tg.initData : '' }, data))
    });
    const json = await res.json();
    if (json.error) throw Object.assign(new Error(json.message || json.error), { code: json.error });
    return json;
  }
  // Кнопка на время запроса: «Сохраняю…», ошибка — тостом
  async function busy(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    try { return await fn(); }
    catch (e) { toast('⚠️ ' + (e.message || 'Ошибка')); return null; }
    finally { btn.disabled = false; btn.textContent = old; }
  }

  function toast(text) {
    const t = $('#toast');
    t.textContent = text; t.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  /* ---------- Панели и «Назад» ---------- */
  let lockedY = 0;
  function openSheet(id) {
    $$('.sheet').forEach(s => s.classList.add('hidden'));
    $(id).classList.remove('hidden');
    if (!document.body.classList.contains('sheet-open')) { lockedY = window.scrollY; document.body.style.top = -lockedY + 'px'; document.body.classList.add('sheet-open'); }
    syncBack();
  }
  function closeSheets() {
    $$('.sheet').forEach(s => s.classList.add('hidden'));
    if (document.body.classList.contains('sheet-open')) { document.body.classList.remove('sheet-open'); document.body.style.top = ''; window.scrollTo(0, lockedY); }
    syncBack();
  }
  const sheetOpen = () => $$('.sheet').some(s => !s.classList.contains('hidden'));
  function syncBack() {
    if (!tg || !tg.BackButton) return;
    if (sheetOpen() || ed) tg.BackButton.show(); else tg.BackButton.hide();
  }
  function goBack() {
    if (sheetOpen()) return closeSheets();
    if (ed) { ed = null; showTab('menu'); }
  }
  if (tg && tg.BackButton) tg.BackButton.onClick(goBack);
  $$('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
  $$('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s) closeSheets(); }));

  /* ---------- Вкладки ---------- */
  function showTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    const navName = name === 'editor' ? 'menu' : name;
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === navName));
    if (name !== 'editor') ed = null;
    if (name === 'settings') loadSettings();
    window.scrollTo(0, 0);
    syncBack();
  }
  $$('.tabs button').forEach(b => b.addEventListener('click', () => { haptic(); showTab(b.dataset.tab); }));

  /* ---------- Загрузка ---------- */
  function apply(d) {
    S = d;
    items = (d.items || []).map(a => ({ name: a[0], type: a[1], kcal: a[2], p: a[3], f: a[4], c: a[5], portion: a[6] || 0 }));
    $('#hello').textContent = 'Админка';
    $('#sub').textContent = 'Привет, ' + d.me.name + ' · ' + dayLabel(d.date);
    renderStats(); renderMenuList(); renderAssign(); renderProducts();
  }
  async function load() {
    const b = $('#reloadBtn');
    b.classList.add('busy');
    try {
      const first = !S;
      apply(await api('adm_init'));
      if (ed) await openEditor(ed.menu.code, ed.day);
      else if (first) { openFromHash(); if (!tourSeen()) setTimeout(startTour, 500); }
    }
    catch (e) { showError(e); }
    finally { b.classList.remove('busy'); document.body.classList.remove('booting'); }
  }
  function showError(e) {
    const msgs = { forbidden: ['🔒', 'Только для тренера', e.message], unauthorized: ['📱', 'Откройте из Telegram', e.message] };
    const [icon, title, text] = msgs[e.code] || ['⚠️', 'Не удалось загрузить', 'Проверьте интернет и нажмите ⟳. ' + (e.message || '')];
    if (S) { toast('⚠️ ' + text); return; }
    $('main').innerHTML = `<div class="error-box"><div class="big">${icon}</div><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p></div>`;
    $('.tabs').classList.add('hidden');
    $('#sub').textContent = '';
  }
  $('#reloadBtn').addEventListener('click', () => { haptic(); load(); });
  // Ссылка с разделом: admin.html#menu, #assign, #products, #menu=<код меню>
  function openFromHash() {
    const h = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    if (!h || /^tgWebApp/.test(h)) return;
    const [tab, code] = h.split('=');
    if (tab === 'menu' && code) openEditor(code);
    else if (tab === 'person' && code) openPerson(code);
    else if (['stats', 'menu', 'assign', 'products', 'settings'].includes(tab)) showTab(tab);
  }

  /* ---------- Сводка ---------- */
  function renderStats() {
    const st = S.stats;
    $('#kpi').innerHTML = [
      [st.reportedToday + ' из ' + st.active, 'прислали отчёт сегодня', st.reportedToday === st.active ? 'good' : ''],
      [st.late, 'давно не присылают отчёт (больше ' + st.lateDays + ' дн.)', st.late ? 'bad' : 'good'],
      [st.outOfCorridor, 'съели сегодня не по норме', st.outOfCorridor ? 'bad' : 'good'],
      [st.measureLate, 'давно не было замеров', st.measureLate ? 'bad' : 'good']
    ].map(([v, t, c]) => `<div class="res-card ${c}"><b>${v}</b><small>${t}</small></div>`).join('');
    const f = { all: () => true, late: p => p.late, out: p => p.out, meas: p => p.measureLate }[statFilter];
    const list = st.people.filter(f);
    $('#people').innerHTML = list.length ? list.map(p => {
      const kc = p.kcal == null ? `<span class="p-plan">${p.target ? 'план ' + fmt(p.target) + ' ккал' : ''}</span>`
        : `<span class="p-kcal ${p.out ? 'bad' : 'ok'}">${fmt(p.kcal)}${p.target ? ' / ' + fmt(p.target) : ''} ккал${p.dev != null ? ' · ' + (p.dev > 0 ? '+' : '') + p.dev + '%' : ''}</span>`;
      const rep = p.lastReport == null ? `<span class="${p.late ? 'bad' : ''}">отчётов пока нет</span>`
        : p.noReport === 0 ? 'отчёт сегодня' : `<span class="${p.late ? 'bad' : ''}">последний отчёт ${p.noReport === 1 ? 'вчера' : p.noReport + ' дн. назад'}</span>`;
      const meas = p.lastMeasure ? `<span class="${p.measureLate ? 'warn' : ''}">замеры ${ddmm(p.lastMeasure)}</span>` : '<span class="warn">замеров нет</span>';
      return `<div class="person ${p.late ? 'late' : p.out || p.measureLate ? 'warn' : ''}" data-fio="${esc(p.fio)}">
        <div class="p-top"><span class="p-name">${esc(p.fio)}</span>${kc}</div>
        <div class="p-meta">${rep}<span>·</span>${meas}${p.weight != null ? '<span>·</span><span>' + fmt(p.weight, 1) + ' кг</span>' : ''}${p.group ? '<span>·</span><span>' + esc(p.group) + '</span>' : ''}</div>
        <div class="p-meta">📅 За неделю: ${p.week ? 'в среднем ' + fmt(p.week.kcal) + ' ккал' + (p.week.dev != null ? ' (' + (p.week.dev > 0 ? '+' : '') + p.week.dev + '%)' : '') + ', отчётов ' + p.week.days : 'отчётов нет'}</div>
        <div class="p-meta">🍽 Меню на эту неделю: ${esc(p.menu || 'нет')}</div>
        ${p.pay ? `<div class="p-meta">💳 ${p.pay.expired ? '<span class="bad">доступ закрыт — период закончился ' + ddmm(p.pay.until) + '</span>' : p.pay.pending ? '<span class="warn">оплата ждёт вашего подтверждения</span>' : '<span class="' + (p.pay.left <= 6 ? 'warn' : '') + '">оплачено до ' + ddmm(p.pay.until) + (p.pay.left <= 6 ? ' (осталось ' + p.pay.left + ' дн.)' : '') + '</span>'}</div>` : ''}
        <div class="p-more">Подробнее ›</div>
      </div>`;
    }).join('') : `<div class="empty">${st.people.length ? 'Таких участников нет 👍' : 'Активных участников пока нет'}</div>`;
  }
  $('#statFilter').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    statFilter = b.dataset.f;
    $$('#statFilter button').forEach(x => x.classList.toggle('on', x === b));
    renderStats();
  });

  /* ---------- Карточка участника: вся статистика по одному человеку ---------- */
  const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const sign = n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), 1);
  async function openPerson(fio) {
    $('#psName').textContent = fio;
    $('#psBody').innerHTML = '<div class="empty">Загрузка…</div>';
    openSheet('#personSheet');
    try { renderPerson(await api('adm_person', { fio })); }
    catch (e) { $('#psBody').innerHTML = `<div class="empty">Не удалось загрузить: ${esc(e.message)}</div>`; }
  }
  function renderPerson(d) {
    const p = d.person, corr = d.corridor;
    const kcalClass = k => !p.target || k == null ? '' : Math.abs(k / p.target - 1) * 100 > corr ? 'bad' : 'ok';
    const weekLine = (w, title) => w
      ? `<div class="ps-week"><b>${title}</b><span>в среднем <b class="${kcalClass(w.kcal)}">${fmt(w.kcal)} ккал</b>${w.dev != null ? ' (' + (w.dev > 0 ? '+' : '') + w.dev + '%)' : ''}${[['Б', w.p], ['Ж', w.f], ['У', w.c]].filter(x => x[1] != null).map(x => ' · ' + x[0] + ' ' + fmt(x[1])).join('')} · отчётов: ${w.days}</span></div>`
      : `<div class="ps-week"><b>${title}</b><span class="muted">отчётов не было</span></div>`;
    // вес: первый и последний из замеров и отчётов
    const wpts = d.measures.filter(m => m.weight != null).map(m => [m.date, m.weight])
      .concat(d.reports.filter(r => r.weight != null).map(r => [r.date, r.weight])).sort((a, b) => a[0] < b[0] ? -1 : 1);
    const w0 = wpts[0], w1 = wpts[wpts.length - 1];
    // калории за 14 дней — столбики
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(addDays(S.date, -i));
    const byDate = {}; d.reports.forEach(r => { byDate[r.date] = r; });
    const maxK = Math.max(p.target || 0, ...d.reports.map(r => r.kcal || 0)) * 1.1 || 1;
    const bars = days.map(ds => {
      const r = byDate[ds], k = r && r.kcal;
      return `<div class="bar ${k == null ? 'none' : kcalClass(k)}" title="${ddmm(ds)}"><i style="height:${k ? Math.round(k / maxK * 100) : 4}%"></i><small>${parseDate(ds).getDate()}</small></div>`;
    }).join('');
    const tLine = p.target ? `<div class="bar-target" style="bottom:${Math.round(p.target / maxK * 100)}%"></div>` : '';
    // замеры: старт → сейчас
    const m0 = d.measures[0], m1 = d.measures[d.measures.length - 1];
    const measHtml = m0 ? `<table class="ps-table"><tr><th></th><th>${ddmm(m0.date)}</th><th>${m1 !== m0 ? ddmm(m1.date) : ''}</th><th>${m1 !== m0 ? 'итого' : ''}</th></tr>` +
      d.metrics.map(([k, name, u]) => m0[k] == null && m1[k] == null ? '' : `<tr><td>${esc(name)}, ${u}</td><td>${fmt(m0[k], 1)}</td><td>${m1 !== m0 ? fmt(m1[k], 1) : ''}</td><td class="${m1 !== m0 && m1[k] != null && m0[k] != null ? (m1[k] < m0[k] ? 'ok' : m1[k] > m0[k] ? 'warn' : '') : ''}">${m1 !== m0 && m1[k] != null && m0[k] != null ? sign(m1[k] - m0[k]) : ''}</td></tr>`).join('') + '</table>'
      : '<div class="muted">Замеров пока нет</div>';
    const rows = d.reports.length ? d.reports.map(r => {
      const dt = parseDate(r.date);
      return `<div class="ps-rep"><span class="dt">${WD[dt.getDay()]}, ${ddmm(r.date)}</span>
        <span><b class="${kcalClass(r.kcal)}">${fmt(r.kcal)} ккал</b> · Б ${fmt(r.p)}${r.weight != null ? ' · ' + fmt(r.weight, 1) + ' кг' : ''}${r.steps != null ? ' · ' + fmt(r.steps) + ' шаг.' : ''}${r.hunger != null ? ' · голод ' + fmt(r.hunger) : ''}</span>
        ${r.note ? `<span class="note">💬 ${esc(r.note)}</span>` : ''}</div>`;
    }).join('') : '<div class="muted">Отчётов пока нет</div>';
    $('#psBody').innerHTML = `
      <div class="muted">${[p.group, p.goal, p.start ? 'старт ' + ddmm(p.start) : '', p.status !== 'активен' ? p.status : ''].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="res-cards" style="margin-top:12px">
        <div class="res-card"><b>${p.target ? fmt(p.target) : '—'}</b><small>норма ккал в день${p.tP ? '<br>Б ' + esc(p.tP) + (p.tF ? ' · Ж ' + esc(p.tF) : '') + (p.tC ? ' · У ' + esc(p.tC) : '') : ''}</small></div>
        <div class="res-card ${d.reported14 / (d.reportedOf || 14) >= 0.85 ? 'good' : d.reported14 / (d.reportedOf || 14) < 0.5 ? 'bad' : ''}"><b>${d.reported14} из ${d.reportedOf || 14}</b><small>${(d.reportedOf || 14) < 14 ? 'дней с отчётом с начала участия' : 'дней с отчётом за 2 недели'}</small></div>
        <div class="res-card ${w0 && w1 && w1[1] < w0[1] ? 'good' : ''}"><b>${w1 ? fmt(w1[1], 1) + ' кг' : '—'}</b><small>${w0 && w1 && w0 !== w1 ? 'вес · ' + sign(w1[1] - w0[1]) + ' кг с ' + ddmm(w0[0]) : 'вес'}</small></div>
        <div class="res-card"><b class="small">${esc(p.menu || 'нет')}</b><small>меню на эту неделю${p.menuAuto ? ' (по калориям)' : ' (назначено)'}</small></div>
      </div>
      <h3 class="ps-h">Калории за 14 дней</h3>
      <div class="bars">${tLine}${bars}</div>
      <div class="muted bars-legend"><span class="dot ok"></span>в норме <span class="dot bad"></span>не по норме <span class="dot none"></span>нет отчёта${p.target ? ' · линия — норма' : ''}</div>
      <h3 class="ps-h">По неделям</h3>
      ${weekLine(d.week, 'Эта неделя')}${weekLine(d.lastWeek, 'Прошлая неделя')}
      <h3 class="ps-h">Замеры</h3>${measHtml}
      <h3 class="ps-h">Отчёты по дням</h3>${rows}`;
  }
  $('#people').addEventListener('click', e => { const c = e.target.closest('[data-fio]'); if (c) { haptic(); openPerson(c.dataset.fio); } });

  /* ---------- Меню: список ---------- */
  function devClass(v) { return v.avgKcal && v.target && Math.abs(v.avgKcal / v.target - 1) > 0.1 ? 'bad' : 'ok'; }
  function renderMenuList() {
    const groups = [['base', 'Обычные меню — работают всегда'], ['week', 'Меню на одну неделю'], ['other', 'Другие']];
    const html = groups.map(([k, title]) => {
      const vs = S.variants.filter(v => v.kind === k);
      if (!vs.length) return '';
      return `<div class="m-group">${title}</div>` + vs.map(v => `
        <button class="m-item" data-code="${esc(v.code)}">
          <span><b>${esc(v.code)}</b><small>${v.avgKcal ? 'в среднем ' + fmt(v.avgKcal) + ' ккал в день' : 'пока пустое — нажмите, чтобы заполнить'}${v.days && v.days < 7 ? ' · заполнено дней: ' + v.days + ' из 7' : ''}</small></span>
          ${v.avgKcal && v.target ? `<span class="dev ${devClass(v)}">${devClass(v) === 'ok' ? '✓ норма' : (v.avgKcal > v.target ? 'много' : 'мало') + ' на ' + Math.abs(Math.round((v.avgKcal / v.target - 1) * 100)) + '%'}</span>` : ''}
        </button>`).join('');
    }).join('');
    $('#menuList').innerHTML = html || '<div class="empty">Меню пока нет</div>';
  }
  $('#menuList').addEventListener('click', e => { const b = e.target.closest('[data-code]'); if (b) { haptic(); openEditor(b.dataset.code); } });

  /* ---------- Меню: редактор ---------- */
  async function openEditor(code, day) {
    showTab('editor');
    ed = { menu: { code, rows: [] }, day: day || 'Пн' };
    syncBack();
    $('#edHead').innerHTML = `<div class="title">${esc(code)}</div><div class="muted">Загрузка…</div>`;
    $('#edDays').innerHTML = ''; $('#edMeals').innerHTML = '';
    try {
      const r = await api('adm_menu', { code });
      if (!r.menu) { toast('Меню не найдено'); showTab('menu'); return; }
      if (!ed || ed.menu.code !== code) return;
      ed.menu = r.menu;
      renderEditor();
    } catch (e) { toast('⚠️ ' + e.message); }
  }
  function renderEditor() {
    const m = ed.menu, D = S.days;
    const kind = { base: 'обычное — работает каждую неделю', week: 'только на одну неделю', other: '' }[m.kind];
    $('#edHead').innerHTML = `<div class="title">${esc(m.code)}</div><div class="muted">${m.target ? fmt(m.target) + ' ккал в день' : ''}${kind ? ' · ' + kind : ''}</div>`;
    $('#edDays').innerHTML = D.map(d => {
      const n = m.rows.filter(r => r.day === d).length;
      return `<button data-d="${d}" class="${d === ed.day ? 'on' : ''}">${d}<small>${n ? '✓' : 'пусто'}</small></button>`;
    }).join('');
    const rows = m.rows.filter(r => r.day === ed.day);
    const total = rows.reduce((a, r) => ({ kcal: a.kcal + (r.kcal || 0), p: a.p + (r.p || 0), f: a.f + (r.f || 0), c: a.c + (r.c || 0) }), { kcal: 0, p: 0, f: 0, c: 0 });
    const dev = m.target && total.kcal ? Math.round((total.kcal / m.target - 1) * 100) : null;
    const groups = [];
    rows.forEach(r => { let g = groups.find(x => x.meal === r.meal); if (!g) { g = { meal: r.meal, rows: [], kcal: 0 }; groups.push(g); } g.rows.push(r); g.kcal += r.kcal || 0; });
    $('#edMeals').innerHTML = `<div class="day-total ${dev != null && Math.abs(dev) > 10 ? 'bad' : ''}"><span>За весь день</span><span>${fmt(total.kcal)}${m.target ? ' из ' + fmt(m.target) : ''} ккал${dev != null && Math.abs(dev) > 10 ? (dev > 0 ? ' — многовато' : ' — маловато') : ''}</span></div>` +
      (groups.length ? groups.map(g => `
        <div class="ed-meal">
          <div class="meal-head"><span class="when">${esc(g.meal)}</span><span class="meal-kcal">${fmt(g.kcal)} ккал</span></div>
          ${g.rows.map(r => `<button class="ed-row" data-row="${r.row}">
            <span><span class="nm">${esc(r.item)}</span><br><span class="am">${fmt(r.qty, 2)} ${esc(UNIT_WORD[r.unit] || r.unit)}</span></span>
            <span class="kc">${fmt(r.kcal)} ккал · изменить</span></button>`).join('')}
          <button class="ed-add" data-meal="${esc(g.meal)}">＋ добавить ещё в «${esc(g.meal)}»</button>
        </div>`).join('') : '<div class="empty">В этот день пока ничего нет.<br>Нажмите «Добавить продукт» ниже 👇</div>');
  }
  $('#edDays').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; ed.day = b.dataset.d; haptic(); renderEditor(); });
  $('#edMeals').addEventListener('click', e => {
    const r = e.target.closest('[data-row]');
    if (r) return openRow('edit', ed.menu.rows.find(x => x.row === +r.dataset.row));
    const a = e.target.closest('[data-meal]');
    if (a) return openRow('add', null, a.dataset.meal);
  });
  $('#edAddMeal').addEventListener('click', () => openRow('add', null, ''));
  $('#edDelete').addEventListener('click', () => askConfirm('Удалить меню «' + ed.menu.code + '»?',
    ed.menu.kind === 'base'
      ? 'Это обычное меню — оно работает каждую неделю. Удалятся все его дни и назначения. Участники этого калоража будут получать ближайшее другое обычное меню.'
      : 'Удалятся все его дни и назначения. Участники получат основное меню своего калоража.', async btn => {
      const r = await busy(btn, 'Удаляю…', () => api('adm_menu_delete', { code: ed.menu.code }));
      if (!r) return;
      S.variants = r.variants; S.assignments = r.assignments;
      closeSheets(); renderMenuList(); renderAssign(); showTab('menu'); toast('Меню удалено'); haptic('ok');
    }));

  /* ---------- Строка меню ---------- */
  function openRow(mode, r, meal) {
    row = { mode, r, meal: r ? r.meal : (meal || ''), unit: r ? r.unit : 'г' };
    $('#rowTitle').textContent = (mode === 'edit' ? 'Изменить продукт · ' : 'Новый продукт · ') + (DAY_WORD[ed.day] || ed.day);
    $('#rowItem').value = r ? r.item : '';
    $('#rowQty').value = r ? String(r.qty).replace('.', ',') : '';
    $('#rowSuggest').innerHTML = '';
    $('#rowDelete').classList.toggle('hidden', mode !== 'edit');
    renderRowChips(); rowCalc();
    openSheet('#rowSheet');
    if (mode === 'add') setTimeout(() => $('#rowItem').focus(), 150);
  }
  function renderRowChips() {
    const meals = S.meals.slice();
    if (row.meal && meals.indexOf(row.meal) < 0) meals.push(row.meal);
    $('#rowMeals').innerHTML = meals.map(m => `<button data-v="${esc(m)}" class="${m === row.meal ? 'on' : ''}">${esc(m)}</button>`).join('');
    $('#rowUnits').innerHTML = S.units.map(u => `<button data-v="${u}" class="${u === row.unit ? 'on' : ''}">${UNIT_WORD[u] || u}</button>`).join('');
  }
  $('#rowMeals').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; row.meal = b.dataset.v; renderRowChips(); });
  $('#rowUnits').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; row.unit = b.dataset.v; renderRowChips(); rowCalc(); });
  const findItem = name => items.find(i => norm(i.name) === norm(name.trim()));
  function rowCalc() {
    const it = findItem($('#rowItem').value), q = num($('#rowQty').value);
    $('#rowInfo').textContent = it ? '✓ ' + (it.type === 'r' ? 'Блюдо (рецепт)' : 'Продукт') + ' · ' + fmt(it.kcal) + ' ккал в 100 г' + (it.portion ? ' · 1 ' + (it.type === 'r' ? 'порция' : 'штука') + ' = ' + fmt(it.portion) + ' г' : '') : '';
    if (!it || q == null) { $('#rowCalc').textContent = ''; return; }
    const grams = row.unit === 'г' ? q : q * (it.portion || 0);
    $('#rowCalc').textContent = grams ? `Это ${fmt(it.kcal * grams / 100)} ккал (белки ${fmt(it.p * grams / 100, 1)}, жиры ${fmt(it.f * grams / 100, 1)}, углеводы ${fmt(it.c * grams / 100, 1)})`
      : `У продукта не указан вес 1 ${row.unit === 'шт' ? 'шт' : 'порции'} — укажите граммы`;
  }
  $('#rowItem').addEventListener('input', () => {
    const q = norm($('#rowItem').value.trim());
    const list = q.length < 2 ? [] : items.filter(i => norm(i.name).includes(q)).slice(0, 25);
    $('#rowSuggest').innerHTML = list.map(i => `<button data-n="${esc(i.name)}"><span>${i.type === 'r' ? '🍳 ' : ''}${esc(i.name)}</span><small>${fmt(i.kcal)} ккал</small></button>`).join('');
    rowCalc();
  });
  $('#rowSuggest').addEventListener('click', e => {
    const b = e.target.closest('[data-n]'); if (!b) return;
    const it = findItem(b.dataset.n);
    $('#rowItem').value = it.name; $('#rowSuggest').innerHTML = '';
    if (it.type === 'r') row.unit = 'порц'; else if (row.unit === 'порц') row.unit = 'г';
    renderRowChips(); rowCalc();
    $('#rowQty').focus();
  });
  $('#rowQty').addEventListener('input', rowCalc);
  $('#rowSave').addEventListener('click', async e => {
    const it = findItem($('#rowItem').value);
    if (!it) return toast('Сначала выберите, что едим: напишите пару букв и нажмите на продукт в списке');
    if (!row.meal) return toast('Выберите, когда едим: завтрак, обед…');
    if (num($('#rowQty').value) == null) return toast('Напишите, сколько: например, 150');
    const body = { meal: row.meal, item: it.name, qty: num($('#rowQty').value), unit: row.unit };
    const r = await busy(e.currentTarget, 'Сохраняю…', () => row.mode === 'edit'
      ? api('adm_row_save', Object.assign(body, { row: row.r.row, expect: { variant: ed.menu.code, day: row.r.day, item: row.r.item } }))
      : api('adm_row_add', Object.assign(body, { code: ed.menu.code, day: ed.day })));
    if (!r) return;
    ed.menu = r.menu; closeSheets(); renderEditor(); haptic('ok'); toast(row.mode === 'edit' ? 'Сохранено' : 'Добавлено');
    refreshVariantsLater();
  });
  $('#rowDelete').addEventListener('click', e => {
    const r0 = row.r;
    askConfirm('Удалить «' + r0.item + '»?', ed.day + ', ' + r0.meal, async btn => {
      const r = await busy(btn, 'Удаляю…', () => api('adm_row_delete', { row: r0.row, expect: { variant: ed.menu.code, day: r0.day, item: r0.item } }));
      if (!r) return;
      ed.menu = r.menu; closeSheets(); renderEditor(); haptic('ok'); toast('Удалено');
      refreshVariantsLater();
    });
  });
  // средние ккал в списке меню — пересчитаем тихо в фоне
  let refreshT = null;
  function refreshVariantsLater() {
    clearTimeout(refreshT);
    refreshT = setTimeout(async () => { try { const d = await api('adm_init'); S.variants = d.variants; S.stats = d.stats; renderMenuList(); renderStats(); } catch (e) {} }, 4000);
  }

  /* ---------- Подтверждение ---------- */
  function askConfirm(text, sub, fn) {
    $('#cfText').textContent = text; $('#cfSub').textContent = sub || '';
    confirmFn = fn;
    openSheet('#confirmSheet');
  }
  $('#cfYes').addEventListener('click', e => { if (confirmFn) confirmFn(e.currentTarget); });

  /* ---------- Недели (для выбора) ---------- */
  function weekOptions(sel, from) {
    const out = [];
    for (let i = -1; i <= 6; i++) {
      const mon = addDays(S.monday, i * 7);
      const label = ddmm(mon) + ' – ' + ddmm(addDays(mon, 6)) + (i === 0 ? ' (эта)' : i === 1 ? ' (следующая)' : i === -1 ? ' (прошлая)' : '');
      if (from == null || i >= from) out.push(`<option value="${mon}">${label}</option>`);
    }
    $(sel).innerHTML = out.join('');
    $(sel).value = S.nextMonday;
  }

  // «На сколько недель»: 1…8 подряд (подпись — с какого по какое число)
  function weeksOptions(sel, weekSel) {
    const mon = $(weekSel).value;
    const out = [];
    for (let n = 1; n <= 8; n++) {
      const label = n === 1 ? '1 неделя' : n + ' ' + (n < 5 ? 'недели' : 'недель') + (mon && mon !== 'base' ? ' (до ' + ddmm(addDays(addDays(mon, 7 * (n - 1)), 6)) + ')' : '');
      out.push(`<option value="${n}">${label}</option>`);
    }
    const cur = $(sel).value || '1';
    $(sel).innerHTML = out.join('');
    $(sel).value = cur;
  }

  /* ---------- Новая неделя: копия или пустое меню ---------- */
  let wkMode = 'copy';
  function renderWeekMode() {
    $$('#wkMode button').forEach(b => b.classList.toggle('on', b.dataset.m === wkMode));
    const tiers = S.tiers.map(t => `<option value="${t}">${t} ккал</option>`).join('');
    $('#wkTier').innerHTML = wkMode === 'copy' ? `<option value="">Для всех калоражей</option>` + tiers : tiers;
    $('#wkHint').textContent = wkMode === 'copy'
      ? 'Скопируем меню прошлой недели (если его не было — основное). Потом можно поменять что нужно.'
      : 'Создадим пустое меню на неделю — и вы сами добавите продукты по дням. Пока оно пустое, участники получают основное меню.';
    $('#wkGo').textContent = wkMode === 'copy' ? 'Создать копию' : 'Создать и заполнить';
    $('#wkMsg').textContent = '';
  }
  $('#wkMode').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; wkMode = b.dataset.m; haptic(); renderWeekMode(); });
  $('#newWeekBtn').addEventListener('click', () => {
    weekOptions('#wkWeek', 0);
    renderWeekMode();
    openSheet('#weekSheet');
  });
  $('#wkGo').addEventListener('click', async e => {
    const r = await busy(e.currentTarget, 'Создаю…', () => api('adm_new_week', { date: $('#wkWeek').value, tier: $('#wkTier').value, mode: wkMode }));
    if (!r) return;
    S.variants = r.variants; renderMenuList(); haptic('ok');
    if (r.empty) { closeSheets(); toast('Меню создано — добавляйте продукты'); openEditor(r.created[0]); return; }
    $('#wkMsg').innerHTML = (r.created.length ? '✅ Создано: ' + r.created.map(esc).join(', ') : 'Ничего не создано') +
      (r.skipped.length ? '<br>Уже были: ' + r.skipped.map(esc).join(', ') : '');
  });

  /* ---------- Меню от ИИ ---------- */
  $('#aiBtn').addEventListener('click', () => {
    aiPick = [S.nextMonday];
    renderAiPeriods();
    $('#aiTier').innerHTML = '<option value="all">Для всех калоражей (1200–3000)</option>' + S.tiers.map(t => `<option value="${t}">${t} ккал</option>`).join('');
    $('#aiResult').innerHTML = '';
    renderAiUndo();
    openSheet('#aiSheet');
  });
  // Выбор периода: «Бессрочно» (основное меню) или одна/несколько недель
  let aiPick = [];
  function renderAiPeriods() {
    const out = [`<button data-w="base" class="${aiPick.includes('base') ? 'on' : ''}">♾ Бессрочно</button>`];
    for (let i = 0; i <= 7; i++) {
      const mon = addDays(S.monday, i * 7);
      out.push(`<button data-w="${mon}" class="${aiPick.includes(mon) ? 'on' : ''}">${ddmm(mon)}–${ddmm(addDays(mon, 6))}</button>`);
    }
    $('#aiPeriods').innerHTML = out.join('');
    $('#aiBaseWarn').classList.toggle('hidden', !aiPick.includes('base'));
  }
  $('#aiPeriods').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const w = b.dataset.w; haptic();
    if (w === 'base') aiPick = aiPick.includes('base') ? [] : ['base'];
    else { aiPick = aiPick.filter(x => x !== 'base'); aiPick = aiPick.includes(w) ? aiPick.filter(x => x !== w) : aiPick.concat(w); }
    renderAiPeriods();
  });
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove(); return ok;
  }
  $('#aiPrompt').addEventListener('click', async e => {
    if (!aiPick.length) return toast('Выберите, на какое время назначить меню');
    const r = await busy(e.currentTarget, 'Генерирую…', () => api('adm_ai_prompt', { tier: $('#aiTier').value, week: aiPick[0], comment: $('#aiComment').value }));
    if (!r) return;
    // текст — в отдельное поле (не в поле для ответа ИИ) и кнопка «Скопировать»: копирование должно идти по нажатию пользователя
    let box = $('#aiPromptOut');
    if (!box) { box = document.createElement('div'); box.id = 'aiPromptOut'; box.className = 'ai-res ok'; $('#aiPrompt').insertAdjacentElement('afterend', box); }
    box.innerHTML = `<b>Шаг 1. Скопируйте этот текст и вставьте в ИИ</b>
      <textarea class="f-in" id="aiPromptText" rows="6" readonly style="margin:8px 0"></textarea>
      <button class="btn primary full" id="aiPromptCopy" type="button">📋 Скопировать</button>`;
    $('#aiPromptText').value = r.text;
    $('#aiPromptCopy').onclick = () => {
      const ta = $('#aiPromptText'); ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
      let ok = false; try { ok = document.execCommand('copy'); } catch (err) {}
      if (ok) { toast('Скопировано! Теперь откройте ИИ и вставьте'); haptic('ok'); return; }
      if (navigator.clipboard) navigator.clipboard.writeText(r.text).then(() => { toast('Скопировано! Теперь откройте ИИ и вставьте'); haptic('ok'); }, () => toast('Текст выделен — нажмите «Копировать» в меню телефона'));
      else toast('Текст выделен — нажмите «Копировать» в меню телефона');
    };
  });
  // «Отменить последнюю загрузку»: возвращает прежние меню и удаляет созданные
  function renderAiUndo() {
    const box = $('#aiUndo');
    box.innerHTML = S.undo ? `<div class="muted">Последняя загрузка: ${esc(S.undo)}</div><button class="link" id="aiUndoBtn">↩ Отменить и вернуть прежние меню</button>` : '';
    if (!S.undo) return;
    $('#aiUndoBtn').onclick = async e => {
      if (!confirm('Отменить последнюю загрузку? Заменённые меню вернутся как были, созданные загрузкой удалятся.')) return;
      const r = await busy(e.currentTarget, 'Отменяю…', () => api('adm_ai_undo', {}));
      if (!r) return;
      S.variants = r.variants; S.undo = ''; renderMenuList(); renderAiUndo(); haptic('ok');
      $('#aiResult').innerHTML = `<div class="ai-res ok">↩ Отменено: вернул ${r.restored}, удалил созданных ${r.removed}</div>`;
    };
  }
  const aiLi = a => '<ul>' + a.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
  function aiProblems(r) {
    $('#aiResult').innerHTML = `<div class="ai-res bad"><b>Ничего не записано</b> — в ответе ИИ нужно поправить:${aiLi(r.problems)}
      <button class="link" id="aiCopyProblems">📋 Скопировать список для ИИ</button></div>`;
    $('#aiCopyProblems').onclick = () => copyText('Исправь и пришли ответ целиком в том же формате:\n- ' + r.problems.join('\n- ')).then(() => toast('Скопировано'));
  }
  // Шаг 1: показываем, что будет добавлено. Шаг 2 (кнопка «Записать») — реальная загрузка.
  $('#aiImport').addEventListener('click', async e => {
    const text = $('#aiText').value.trim();
    if (!text) return toast('Вставьте ответ ИИ');
    if (!aiPick.length) return toast('Выберите, на какое время назначить меню');
    const p = await busy(e.currentTarget, 'Проверяю…', () => api('adm_ai_preview', { text, all: $('#aiTier').value === 'all', weeks: aiPick, tier: $('#aiTier').value }));
    if (!p) return;
    if (!p.ok) return aiProblems(p);
    const first = p.periods[0];
    const dayHtml = i => {
      const d = p.days[i];
      return `<div class="day-total"><span>${esc(d.full)}</span><span>${fmt(d.total.kcal)} ккал · Б ${fmt(d.total.p)} Ж ${fmt(d.total.f)} У ${fmt(d.total.c)}</span></div>` +
        d.meals.map(g => `<div class="meal"><div class="meal-head"><span class="when">${esc(g.name)}</span><span class="meal-kcal">${fmt(g.kcal)} ккал</span></div>` +
          g.items.map(x => `<div class="dish-row"><div class="dish">${esc(x.item)}</div><div class="nut">${fmt(x.qty, 2)} ${esc(x.unit)}${x.grams ? ' · ≈' + fmt(x.grams) + ' г' : ''} · ${fmt(x.kcal)} ккал · Б ${fmt(x.p, 1)} Ж ${fmt(x.f, 1)} У ${fmt(x.c, 1)}</div></div>`).join('') + '</div>').join('');
    };
    const per = p.periods.map(x => `<div class="pv-row"><span>${esc(x.code)}</span><b class="${x.replaces ? 'warn' : 'new'}">${x.replaces ? 'заменит существующее' : 'новое'}</b></div>`).join('');
    const extra = [
      p.scaledNew ? `<div class="pv-row"><span>Пересчёт на другие калоражи</span><b>+${p.scaledNew} меню</b></div>` : '',
      p.newProducts.length ? `<div class="pv-h">Новые продукты (на 100 г)</div>` + p.newProducts.map(x => `<div class="pv-row"><span>${esc(x[0])}</span><span class="muted">${x[1]} ккал · Б ${x[2]} Ж ${x[3]} У ${x[4]}</span></div>`).join('') : '',
      p.newRecipes.length ? `<div class="pv-h">Новые рецепты</div><div class="pv-text">${p.newRecipes.map(esc).join(', ')}</div>` : '',
      p.replacedRecipes.length ? `<div class="pv-h">Рецепты заменятся новым составом</div><div class="pv-text">${p.replacedRecipes.map(esc).join(', ')}</div>` : '',
      p.warnings.length ? `<div class="pv-h">⚠️ Проверьте</div>` + p.warnings.map(w => `<div class="pv-text warn">${esc(w)}</div>`).join('') : ''
    ].join('');
    $('#aiResult').innerHTML = `<div class="pv">
      <div class="pv-top">👀 Так меню увидит участник</div>
      <div class="menu-head card"><div class="code">${esc(first.code)}</div><div class="title">Меню на ${p.tier} ккал</div><div class="muted">${p.tier} ккал в день · дней: 7</div></div>
      <div class="days" id="pvDays">${p.days.map((d, i) => `<button data-d="${i}" class="${i === 0 ? 'on' : ''}">${esc(d.day)}</button>`).join('')}</div>
      <div id="pvMeals">${dayHtml(0)}</div>
      <div class="pv-h" style="margin-top:14px">Что будет записано</div>${per}${extra}
      <button class="btn primary full" id="aiConfirm" style="margin-top:14px">✅ Записать в таблицу</button><button class="link" id="aiCancel" style="display:block;margin:10px auto 0">Отмена</button></div>`;
    $('#pvDays').onclick = ev => { const b = ev.target.closest('button'); if (!b) return; document.querySelectorAll('#pvDays button').forEach(x => x.classList.toggle('on', x === b)); $('#pvMeals').innerHTML = dayHtml(+b.dataset.d); haptic(); };
    $('#aiConfirm').onclick = ev => doAiImport(ev.currentTarget, text);
    $('#aiCancel').onclick = () => { $('#aiResult').innerHTML = ''; };
    $('#aiResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  async function doAiImport(btn, text) {
    const r = await busy(btn, 'Загружаю…', () => api('adm_ai_import', { text, all: $('#aiTier').value === 'all', weeks: aiPick, tier: $('#aiTier').value }));
    if (!r) return;
    const li = aiLi;
    if (!r.ok) return aiProblems(r);
    S.variants = r.variants; renderMenuList(); haptic('ok');
    $('#aiText').value = '';
    $('#aiResult').innerHTML = `<div class="ai-res ok"><b>✅ Загружено:</b> ${r.codes.map(esc).join(', ')}<br>Новых продуктов: ${r.products}, рецептов: ${r.recipes}` +
      (r.newProducts && r.newProducts.length ? `<br><br><b>Новые продукты — проверьте цифры (на 100 г):</b>${li(r.newProducts.map(p => p[0] + ' — ' + p[1] + ' ккал, Б ' + p[2] + ', Ж ' + p[3] + ', У ' + p[4]))}` : '') + +
      (r.scaled ? `<br>Пересчитано на другие калоражи: ${r.scaled.created} меню` + (r.scaled.skipped ? ` (уже были, не менялись: ${r.scaled.skipped})` : '') : '') +
      (r.warnings.length ? `<br><br>⚠️ Проверьте:${li(r.warnings)}` : '') +
      `<br><button class="link" id="aiOpen">Открыть меню →</button></div>`;
    $('#aiOpen').onclick = () => { closeSheets(); openEditor(r.codes[0]); };
    S.undo = r.undo; renderAiUndo();
    refreshVariantsLater();
  }

  /* ---------- Назначения ---------- */
  function renderAssign() {
    weekOptions('#asWeek');
    weeksOptions('#asWeeks', '#asWeek');
    $('#asTarget').innerHTML = S.targets.map(t => `<option>${esc(t)}</option>`).join('');
    $('#asVariant').innerHTML = S.variants.map(v => `<option value="${esc(v.code)}">${esc(v.code)}</option>`).join('');
    const cur = S.monday;
    $('#asList').innerHTML = S.assignments.length ? S.assignments.map(a => `
      <div class="as-item ${a.week < cur ? 'past' : ''}">
        <span><b>${esc(a.target)}</b><small>${ddmm(a.week)} – ${ddmm(addDays(a.week, 6))} · ${esc(a.variant)}</small></span>
        <button class="x" data-row="${a.row}" aria-label="Убрать">✕</button>
      </div>`).join('') : '<div class="empty">Назначений нет — все получают меню по калоражу</div>';
  }
  $('#asWeek').addEventListener('change', () => weeksOptions('#asWeeks', '#asWeek'));
  $('#asSave').addEventListener('click', async e => {
    const r = await busy(e.currentTarget, 'Сохраняю…', () => api('adm_assign', { week: $('#asWeek').value, weeks: +$('#asWeeks').value, target: $('#asTarget').value, variant: $('#asVariant').value }));
    if (!r) return;
    S.assignments = r.assignments; S.stats = r.stats; renderAssign(); renderStats(); haptic('ok');
    toast(r.updated && !r.added ? 'Назначение обновлено' : r.added > 1 || r.updated ? 'Назначено на недель: ' + (r.added + r.updated) : 'Назначено');
  });
  $('#asList').addEventListener('click', e => {
    const b = e.target.closest('[data-row]'); if (!b) return;
    const a = S.assignments.find(x => x.row === +b.dataset.row);
    askConfirm('Убрать назначение?', a.target + ' · ' + a.variant, async btn => {
      const r = await busy(btn, 'Убираю…', () => api('adm_unassign', { row: a.row, expect: { target: a.target, variant: a.variant } }));
      if (!r) return;
      S.assignments = r.assignments; S.stats = r.stats; closeSheets(); renderAssign(); renderStats(); haptic('ok');
    });
  });

  /* ---------- Продукты ---------- */
  function renderProducts() {
    const q = norm($('#prSearch').value.trim());
    const list = S.products.filter(p => !q || norm(p[0]).includes(q));
    $('#prCount').textContent = q ? 'Найдено: ' + list.length : 'Всего продуктов: ' + S.products.length;
    $('#prList').innerHTML = list.slice(0, 200).map(p => `<button class="pr-item" data-n="${esc(p[0])}"><span>${esc(p[0])}</span><small>${fmt(p[1])} ккал · Б ${fmt(p[2], 1)} Ж ${fmt(p[3], 1)} У ${fmt(p[4], 1)}</small></button>`).join('')
      || '<div class="empty">Не найдено. Нажмите «➕ Новый», чтобы добавить.</div>';
  }
  $('#prSearch').addEventListener('input', renderProducts);
  function openProduct(p) {
    $('#prTitle').textContent = p ? 'Исправить продукт' : 'Новый продукт';
    $('#prName').value = p ? p[0] : $('#prSearch').value.trim();
    $('#prName').disabled = !!p;
    ['#prKcal', '#prP', '#prF', '#prC', '#prPiece'].forEach((id, i) => { $(id).value = p && p[i + 1] !== '' && p[i + 1] != null ? String(p[i + 1]).replace('.', ',') : ''; });
    prCheck();
    openSheet('#prSheet');
  }
  function prCheck() {
    const [k, p, f, c] = ['#prKcal', '#prP', '#prF', '#prC'].map(id => num($(id).value));
    if ([k, p, f, c].some(x => x == null) || !k) { $('#prCheck').textContent = ''; return; }
    const calc = 4 * p + 9 * f + 4 * c;
    $('#prCheck').textContent = Math.abs(calc - k) / k > 0.2 ? `⚠️ По Б/Ж/У выходит ≈${fmt(calc)} ккал — проверьте цифры` : '';
  }
  ['#prKcal', '#prP', '#prF', '#prC'].forEach(id => $(id).addEventListener('input', prCheck));
  $('#prList').addEventListener('click', e => { const b = e.target.closest('[data-n]'); if (b) openProduct(S.products.find(p => p[0] === b.dataset.n)); });
  $('#prAdd').addEventListener('click', () => openProduct(null));
  $('#prSave').addEventListener('click', async e => {
    const body = { name: $('#prName').value.trim(), kcal: num($('#prKcal').value), p: num($('#prP').value), f: num($('#prF').value), c: num($('#prC').value), piece: num($('#prPiece').value) };
    if (!body.name) return toast('Укажите название');
    if ([body.kcal, body.p, body.f, body.c].some(x => x == null)) return toast('Заполните ккал, Б, Ж, У');
    const r = await busy(e.currentTarget, 'Сохраняю…', () => api('adm_product_save', body));
    if (!r) return;
    S.products = r.products; S.items = r.items;
    items = r.items.map(a => ({ name: a[0], type: a[1], kcal: a[2], p: a[3], f: a[4], c: a[5], portion: a[6] || 0 }));
    closeSheets(); renderProducts(); haptic('ok'); toast(r.created ? 'Продукт добавлен' : 'Сохранено');
  });

  /* ---------- Настройки: настройки бота, тексты сообщений, вопросы анкеты ---------- */
  let SET = null;            // ответ adm_settings
  let setPart = 'settings';
  let editing = null;        // {kind: 'setting'|'text'|'question', item}
  const DAYS_ALL = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  function daysWord(v) {
    const d = String(v || '').split(/[\s,;]+/).filter(Boolean);
    if (!d.length || d.length === 7) return 'каждый день';
    if (d.join(',') === 'Пн,Вт,Ср,Чт,Пт') return 'по будням';
    return d.join(', ');
  }
  function valueWord(s) {
    if (s.type === 'days') return daysWord(s.value);
    if (s.type === 'select' && DAY_WORD[s.value]) return 'в ' + DAY_WORD[s.value].replace('среда', 'среду').replace('пятница', 'пятницу').replace('суббота', 'субботу');
    if (s.key === 'CALORIE_CORRIDOR') return '±' + s.value + '%';
    if (s.key === 'REPEAT_WEEKS') return s.value + ' нед.';
    if (s.type === 'number') return s.value + ' дн.';
    return s.value || '—';
  }
  async function loadSettings() {
    if (SET) return renderSettings();
    $('#setList').innerHTML = '<div class="empty">Загрузка…</div>';
    try { SET = await api('adm_settings'); renderSettings(); }
    catch (e) { $('#setList').innerHTML = `<div class="empty">Не удалось загрузить: ${esc(e.message)}</div>`; }
  }
  function renderSettings() {
    $$('#setPart button').forEach(b => b.classList.toggle('on', b.dataset.p === setPart));
    if (!SET) return;
    let html = '';
    if (setPart === 'settings') {
      html += `<div class="hint-line">⏰ Время — ${({ 'Europe/Moscow': 'по Москве', 'Asia/Irkutsk': 'по Иркутску (МСК+5, как на Бали)', 'Asia/Makassar': 'по Бали' })[SET.tz] || 'по поясу ' + esc(SET.tz)}. Нажмите на строку, чтобы изменить.</div>`;
      const groups = [];
      SET.settings.forEach(s => { let g = groups.find(x => x.name === s.group); if (!g) { g = { name: s.group, items: [] }; groups.push(g); } g.items.push(s); });
      html += groups.map(g => `<div class="m-group">${esc(g.name)}</div><div class="set-card">` +
        g.items.map(s => `<button class="set-row" data-k="${s.key}"><span>${esc(s.label)}</span><b>${esc(valueWord(s))}</b></button>`).join('') + '</div>').join('');
    } else if (setPart === 'texts') {
      html += '<div class="hint-line">💬 Что бот пишет участникам. Нажмите, чтобы изменить текст.</div>';
      html += '<div class="set-card">' + SET.texts.map(t => `<button class="set-row tall" data-t="${t.key}"><span><b class="t-name">${esc(t.label)}</b><small>${esc(plain(t.text).slice(0, 90))}${plain(t.text).length > 90 ? '…' : ''}</small></span><i>›</i></button>`).join('') + '</div>';
    } else {
      html += '<div class="hint-line">📝 Вопросы анкеты для новых людей. Можно поменять формулировку. Добавить или удалить вопрос — через меня (разработчика).</div>';
      const secs = [];
      SET.questions.forEach(q => { let s = secs.find(x => x.name === q.section); if (!s) { s = { name: q.section, items: [] }; secs.push(s); } s.items.push(q); });
      html += secs.map(s => `<div class="m-group">${esc(s.name)}</div><div class="set-card">` +
        s.items.map(q => `<button class="set-row tall" data-q="${q.key}"><span>${esc(q.text)}${q.text !== q.def ? ' <em class="changed">изменён</em>' : ''}</span><i>›</i></button>`).join('') + '</div>').join('');
    }
    $('#setList').innerHTML = html;
  }
  const plain = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  $('#setPart').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; setPart = b.dataset.p; haptic(); renderSettings(); });
  $('#setList').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !SET) return;
    if (b.dataset.k) openSetting(SET.settings.find(s => s.key === b.dataset.k));
    else if (b.dataset.t) openText('text', SET.texts.find(t => t.key === b.dataset.t));
    else if (b.dataset.q) openText('question', SET.questions.find(q => q.key === b.dataset.q));
  });

  // одна настройка
  function openSetting(s) {
    editing = { kind: 'setting', item: s, days: String(s.value || '').split(/[\s,;]+/).filter(Boolean), choice: s.value };
    $('#stTitle').textContent = s.label;
    $('#stHint').textContent = s.hint || '';
    let body = '';
    if (s.type === 'time') body = `<input class="f-in" id="stVal" type="time" value="${esc(s.value)}">`;
    else if (s.type === 'number') body = `<input class="f-in" id="stVal" inputmode="numeric" value="${esc(s.value)}"><div class="muted" style="margin-top:6px">От ${s.min} до ${s.max}</div>`;
    else if (s.type === 'ids') body = `<input class="f-in" id="stVal" inputmode="numeric" value="${esc(s.value)}"><div class="muted" style="margin-top:6px">Свой ID человек узнаёт, написав боту /id</div>`;
    else if (s.type === 'days') body = `<div class="chips" id="stDays"></div><button class="link" id="stAll">Выбрать все дни</button>`;
    else body = '<div class="chips" id="stOpts"></div>';
    $('#stBody').innerHTML = body;
    renderSettingChips();
    openSheet('#setSheet');
  }
  function renderSettingChips() {
    const s = editing.item;
    if (s.type === 'days') $('#stDays').innerHTML = DAYS_ALL.map(d => `<button data-d="${d}" class="${editing.days.includes(d) ? 'on' : ''}">${d}</button>`).join('');
    if (s.type === 'select') $('#stOpts').innerHTML = s.options.map(o => `<button data-o="${esc(o)}" class="${o === editing.choice ? 'on' : ''}">${esc(DAY_WORD[o] ? DAY_WORD[o] : o)}</button>`).join('');
  }
  $('#stBody').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !editing) return;
    if (b.id === 'stAll') editing.days = DAYS_ALL.slice();
    else if (b.dataset.d) editing.days = editing.days.includes(b.dataset.d) ? editing.days.filter(x => x !== b.dataset.d) : editing.days.concat(b.dataset.d);
    else if (b.dataset.o) editing.choice = b.dataset.o;
    haptic(); renderSettingChips();
  });
  $('#stSave').addEventListener('click', async e => {
    const s = editing.item;
    const value = s.type === 'days' ? DAYS_ALL.filter(d => editing.days.includes(d)).join(',') : s.type === 'select' ? editing.choice : $('#stVal').value.trim();
    const r = await busy(e.currentTarget, 'Сохраняю…', () => api('adm_setting_save', { key: s.key, value }));
    if (!r) return;
    SET.settings = r.settings; closeSheets(); renderSettings(); haptic('ok'); toast('Сохранено. Заработает в течение 10 минут');
  });

  // текст сообщения или вопрос анкеты
  function openText(kind, t) {
    editing = { kind, item: t };
    $('#txTitle').textContent = kind === 'question' ? 'Вопрос анкеты · ' + t.section : t.label;
    $('#txHelp').innerHTML = kind === 'question'
      ? 'Одной строкой. Человек увидит этот вопрос в анкете. Смысл лучше не менять — ответы на старые и новые вопросы окажутся в одной колонке.'
      : 'Можно вставлять: <b>{имя}</b> — имя участника, <b>{калораж}</b> — его калории, <b>{период}</b> — даты недели.<br>Жирный текст: &lt;b&gt;слово&lt;/b&gt;. Новая строка — просто Enter.';
    $('#txText').value = t.text;
    $('#txText').rows = kind === 'question' ? 2 : 8;
    $('#txReset').classList.toggle('hidden', t.text === t.def);
    openSheet('#textSheet');
  }
  async function saveText(btn, reset) {
    const t = editing.item;
    const r = await busy(btn, reset ? 'Возвращаю…' : 'Сохраняю…', () => api('adm_text_save', reset ? { key: t.key, reset: true } : { key: t.key, text: $('#txText').value }));
    if (!r) return;
    SET.texts = r.texts; SET.questions = r.questions; closeSheets(); renderSettings(); haptic('ok'); toast(reset ? 'Вернули исходный текст' : 'Сохранено');
  }
  $('#txSave').addEventListener('click', e => saveText(e.currentTarget, false));
  $('#txReset').addEventListener('click', e => saveText(e.currentTarget, true));

  /* ---------- Обучение (подробное, показывается при первом входе; «?» — снова) ---------- */
  const tourUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : 'demo';
  const TOUR_KEY = 'admin-tour-v2-' + tourUser;
  // el — что подсветить (селектор), tab — какую вкладку открыть перед этим; без el — карточка по центру
  const TOUR = [
    { ic: '👋', t: 'Привет! Это админка', x: 'Здесь вы управляете группой прямо с телефона.<br>Всё, что вы тут меняете, сразу попадает в Google Таблицу.<br><br>Сейчас покажу, где что. Нажимайте «Далее».' },
    { tab: 'stats', el: '.tabs button[data-tab="stats"]', ic: '📊', t: 'Сводка', x: 'Здесь видно, как дела у ваших участников сегодня.' },
    { tab: 'stats', el: '#kpi', ic: '🔢', t: 'Четыре главные цифры', x: '<b>Прислали отчёт</b> — сколько человек уже прислали отчёт сегодня.<br><b>Давно не присылают</b> — кто молчит несколько дней.<br><b>Не по норме</b> — кто съел сегодня сильно больше или меньше, чем нужно.<br><b>Давно не было замеров</b> — кто давно не присылал замеры.<br><br>🔴 Красная цифра — значит, кому-то нужно написать.' },
    { tab: 'stats', el: '#statFilter', ic: '🔎', t: 'Кнопки-фильтры', x: 'Нажмите, и останутся только нужные люди.<br>Например, «Нет отчёта» — покажет только тех, кто не прислал отчёт.<br>«Все» — снова покажет всех.' },
    { tab: 'stats', el: '#people .person', ic: '👤', t: 'Карточка человека', x: '<b>Справа</b> — сколько он съел сегодня и сколько ему можно. Зелёное — всё хорошо, красное — перебор или недобор. Серое «план» — отчёта ещё нет.<br><br><b>Полоска слева:</b><br>🔴 красная — давно нет отчёта;<br>🟠 оранжевая — не в норме по калориям или нет замера.<br><br>Ниже — как он ел за неделю и какое у него меню.' },
    { tab: 'stats', el: '#people .person', ic: '📈', t: 'Вся статистика человека', x: '<b>Нажмите на карточку</b> — откроется всё про человека:<br>• его норма и вес (сколько сбросил или набрал);<br>• калории за 14 дней столбиками: зелёные — в норме, красные — нет, серые — нет отчёта;<br>• средние за эту и прошлую неделю;<br>• замеры: первый и последний, и разница;<br>• все отчёты по дням с комментариями.' },
    { tab: 'menu', el: '.tabs button[data-tab="menu"]', ic: '📋', t: 'Меню', x: 'Здесь все меню. Их можно смотреть и менять.' },
    { tab: 'menu', el: '#menuList .m-item', ic: '🗂', t: 'Какие бывают меню', x: '<b>«Основное»</b> — меню, которое работает всегда, каждую неделю.<br><b>«Неделя 24.11»</b> — меню только на одну неделю. Пока эта неделя идёт, оно главнее основного.<br><br>Процент справа — насколько меню отличается от своих калорий. Красный — сильно отличается, стоит поправить.<br><br>👉 Нажмите на меню, чтобы открыть его.' },
    { tab: 'menu', ic: '✏️', t: 'Как поменять продукт', x: 'Внутри меню сверху дни: Пн, Вт, Ср…<br><br>1. Выберите день.<br>2. Нажмите на продукт.<br>3. Поменяйте его на другой, измените граммы или удалите.<br>4. Нажмите «Сохранить».<br><br>Чтобы добавить продукт — нажмите «+ добавить ещё» под нужным приёмом пищи. Калории посчитаются сами.' },
    { tab: 'menu', el: '#newWeekBtn', ic: '➕', t: 'Новая неделя', x: 'Два способа:<br><b>Копия прошлой</b> — повторит прошлое меню, вы поменяете пару продуктов.<br><b>Пустое</b> — чистое меню, и вы сами добавите продукты по дням.<br><br>Участники получат новое меню сами.' },
    { tab: 'menu', el: '#aiBtn', ic: '🤖', t: 'Меню от ИИ', x: 'ИИ может составить меню за вас:<br><br>1. Напишите калории и пожелания.<br>2. Нажмите «Скопировать задание для ИИ».<br>3. Вставьте его в ИИ и отправьте.<br>4. Скопируйте ответ ИИ, вставьте сюда и нажмите «Загрузить в меню».<br><br>Если ИИ ошибся — ничего не сломается. Вы увидите, что не так, и сможете отправить это обратно в ИИ.' },
    { tab: 'assign', el: '.tabs button[data-tab="assign"]', ic: '🗓', t: 'Назначения', x: 'Обычно ничего делать не нужно: каждый сам получает меню под свои калории.<br><br>Сюда заходите, только если кому-то нужно <b>особое</b> меню.' },
    { tab: 'assign', el: '#tab-assign .card', ic: '🎯', t: 'Как дать особое меню', x: '1. Выберите неделю.<br>2. Выберите, кому: всем, группе или одному человеку.<br>3. Выберите меню.<br>4. Нажмите «Дать это меню».<br><br>Если человеку и группе назначено разное — человек получит своё, личное.' },
    { tab: 'assign', el: '#asList', ic: '✕', t: 'Убрать назначение', x: 'Здесь список всех особых меню.<br>Нажмите ✕ — и человек снова будет получать обычное меню под свои калории.' },
    { tab: 'products', el: '.tabs button[data-tab="products"]', ic: '🥦', t: 'Продукты', x: 'Здесь все продукты и сколько в них калорий, белков, жиров и углеводов на 100 грамм.<br>По ним считаются все меню.' },
    { tab: 'products', el: '.search-row', ic: '🔍', t: 'Найти или добавить продукт', x: '<b>Найти:</b> начните писать название в поиске.<br><b>Исправить:</b> нажмите на продукт и поменяйте цифры.<br><b>Добавить:</b> нажмите «➕ Новый». Цифры берите с упаковки или из FatSecret.<br><br>Если продукт считают штуками (яйцо, яблоко) — напишите, сколько весит одна штука.' },
    { tab: 'settings', el: '.tabs button[data-tab="settings"]', ic: '⚙️', t: 'Настройки', x: 'Здесь можно поменять, <b>когда</b> бот пишет и <b>что</b> он пишет.<br>Сверху три кнопки: «Настройки», «Тексты», «Анкета».' },
    { tab: 'settings', el: '#setPart', ic: '⏰', t: 'Настройки', x: '<b>Настройки</b> — во сколько и в какие дни бот напоминает об отчёте и замерах, когда присылает вам сводку и меню участникам.<br><br>Нажмите на строку → выберите время или дни → «Сохранить». Заработает в течение 10 минут.' },
    { tab: 'settings', el: '#setPart', ic: '💬', t: 'Тексты', x: '<b>Тексты</b> — что бот пишет людям: приветствие, напоминания, ответы.<br><br>Нажмите на текст → исправьте → «Сохранить». Передумали — «Вернуть как было».<br>{имя} бот сам заменит на имя человека.' },
    { tab: 'settings', el: '#setPart', ic: '📝', t: 'Анкета', x: '<b>Анкета</b> — вопросы, на которые отвечает новый человек.<br><br>Можно поменять формулировку вопроса. Смысл лучше оставить прежним.' },
    { tab: 'stats', el: '#reloadBtn', ic: '⟳', t: 'Обновить', x: 'Если что-то поменяли прямо в таблице — нажмите эту кнопку, и здесь всё обновится.<br><br>Иногда первая загрузка идёт 10–15 секунд. Это нормально, просто подождите.' },
    { tab: 'stats', el: '#helpBtn', ic: '❓', t: 'Забыли, что где?', x: 'Нажмите на вопросик — и я снова всё покажу.' },
    { ic: '✅', t: 'Готово!', x: 'Теперь вы знаете всё самое главное.<br><br>Анкеты новых людей, отчёты и оплаты по-прежнему приходят вам в чат с ботом.' }
  ];
  let tourStep = 0;
  function tourSeen() { try { return !!localStorage.getItem(TOUR_KEY); } catch (e) { return true; } }
  function startTour() {
    tourStep = 0;
    closeSheets();
    ed = null;
    $('#tour').classList.remove('hidden');
    $('#tourDots').innerHTML = TOUR.map(() => '<i></i>').join('');
    showTourStep();
  }
  function endTour() {
    $('#tour').classList.add('hidden');
    try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) {}
    showTab('stats');
  }
  function showTourStep() {
    const s = TOUR[tourStep], spot = $('#tourSpot'), card = $('#tourCard');
    $('#tourIc').textContent = s.ic; $('#tourT').textContent = s.t; $('#tourX').innerHTML = s.x;
    $$('#tourDots i').forEach((d, i) => d.classList.toggle('on', i === tourStep));
    $('#tourNext').textContent = tourStep === TOUR.length - 1 ? 'Понятно 👍' : 'Далее';
    $('#tourSkip').style.display = tourStep === TOUR.length - 1 ? 'none' : '';
    $('#tourBack').style.display = tourStep === 0 ? 'none' : '';
    if (s.tab) showTab(s.tab);
    const el = s.el && $(s.el);
    if (el && el.offsetParent !== null) {
      // блок — в верхнюю часть экрана, чтобы рядом поместилась карточка
      const r0 = el.getBoundingClientRect();
      if (r0.top < 60 || r0.bottom > window.innerHeight - 60) window.scrollBy(0, r0.top - 90);
      const r = el.getBoundingClientRect();
      const h = Math.min(r.height, window.innerHeight * 0.45);
      Object.assign(spot.style, { left: (r.left - 4) + 'px', top: (r.top - 4) + 'px', width: (r.width + 8) + 'px', height: (h + 8) + 'px' });
      spot.classList.remove('center');
      if (r.top > window.innerHeight / 2) { card.style.top = ''; card.style.bottom = (window.innerHeight - r.top + 14) + 'px'; }
      else { card.style.bottom = ''; card.style.top = (r.top + h + 18) + 'px'; }
    } else {
      spot.classList.add('center');
      card.style.bottom = ''; card.style.top = '22%';
    }
    haptic();
  }
  $('#tourNext').addEventListener('click', () => { tourStep += 1; if (tourStep >= TOUR.length) endTour(); else showTourStep(); });
  $('#tourBack').addEventListener('click', () => { if (tourStep > 0) { tourStep -= 1; showTourStep(); } });
  $('#tourSkip').addEventListener('click', endTour);
  $('#helpBtn').addEventListener('click', () => { haptic(); startTour(); });
  window.addEventListener('resize', () => { if (!$('#tour').classList.contains('hidden')) showTourStep(); });

  load();
})();
