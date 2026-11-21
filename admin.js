/* Админка тренера — Telegram Mini App. Данные: тот же Google Apps Script API (config.js), действия «adm_…». */
(function () {
  'use strict';

  const tg = window.Telegram && Telegram.WebApp;
  const API = window.APP_CONFIG.api;
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  let S = null;              // ответ adm_init
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
    else if (['stats', 'menu', 'assign', 'products'].includes(tab)) showTab(tab);
  }

  /* ---------- Сводка ---------- */
  function renderStats() {
    const st = S.stats;
    $('#kpi').innerHTML = [
      [st.reportedToday + ' / ' + st.active, 'сдали отчёт сегодня', st.reportedToday === st.active ? 'good' : ''],
      [st.late, 'без отчёта больше ' + st.lateDays + ' дн.', st.late ? 'bad' : 'good'],
      [st.outOfCorridor, 'вне коридора ±' + st.corridor + '% сегодня', st.outOfCorridor ? 'bad' : 'good'],
      [st.measureLate, 'просрочен замер', st.measureLate ? 'bad' : 'good']
    ].map(([v, t, c]) => `<div class="res-card ${c}"><b>${v}</b><small>${t}</small></div>`).join('');
    const f = { all: () => true, late: p => p.late, out: p => p.out, meas: p => p.measureLate }[statFilter];
    const list = st.people.filter(f);
    $('#people').innerHTML = list.length ? list.map(p => {
      const kc = p.kcal == null ? `<span class="p-plan">${p.target ? 'план ' + fmt(p.target) + ' ккал' : ''}</span>`
        : `<span class="p-kcal ${p.out ? 'bad' : 'ok'}">${fmt(p.kcal)}${p.target ? ' / ' + fmt(p.target) : ''} ккал${p.dev != null ? ' · ' + (p.dev > 0 ? '+' : '') + p.dev + '%' : ''}</span>`;
      const rep = p.lastReport == null ? '<span class="bad">отчётов нет</span>'
        : p.noReport === 0 ? 'отчёт сегодня' : `<span class="${p.late ? 'bad' : ''}">отчёт ${p.noReport} дн. назад</span>`;
      const meas = p.lastMeasure ? `<span class="${p.measureLate ? 'warn' : ''}">замер ${ddmm(p.lastMeasure)}</span>` : '<span class="warn">замеров нет</span>';
      return `<div class="person ${p.late ? 'late' : p.out || p.measureLate ? 'warn' : ''}">
        <div class="p-top"><span class="p-name">${esc(p.fio)}</span>${kc}</div>
        <div class="p-meta">${rep}<span>·</span>${meas}${p.weight != null ? '<span>·</span><span>' + fmt(p.weight, 1) + ' кг</span>' : ''}${p.group ? '<span>·</span><span>' + esc(p.group) + '</span>' : ''}</div>
        <div class="p-meta">📋 ${esc(p.menu || 'меню нет')}</div>
      </div>`;
    }).join('') : `<div class="empty">${st.people.length ? 'Таких участников нет 👍' : 'Активных участников пока нет'}</div>`;
  }
  $('#statFilter').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    statFilter = b.dataset.f;
    $$('#statFilter button').forEach(x => x.classList.toggle('on', x === b));
    renderStats();
  });

  /* ---------- Меню: список ---------- */
  function devClass(v) { return v.avgKcal && v.target && Math.abs(v.avgKcal / v.target - 1) > 0.1 ? 'bad' : 'ok'; }
  function renderMenuList() {
    const groups = [['base', 'Основные (действуют каждую неделю)'], ['week', 'На конкретную неделю'], ['other', 'Другие']];
    const html = groups.map(([k, title]) => {
      const vs = S.variants.filter(v => v.kind === k);
      if (!vs.length) return '';
      return `<div class="m-group">${title}</div>` + vs.map(v => `
        <button class="m-item" data-code="${esc(v.code)}">
          <span><b>${esc(v.code)}</b><small>${v.days} дн.${v.avgKcal ? ' · в среднем ' + fmt(v.avgKcal) + ' ккал' : ' · пусто'}</small></span>
          ${v.avgKcal && v.target ? `<span class="dev ${devClass(v)}">${(v.avgKcal >= v.target ? '+' : '') + Math.round((v.avgKcal / v.target - 1) * 100)}%</span>` : ''}
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
    const kind = { base: 'основное — действует каждую неделю', week: 'на конкретную неделю', other: '' }[m.kind];
    $('#edHead').innerHTML = `<div class="title">${esc(m.code)}</div><div class="muted">${m.target ? fmt(m.target) + ' ккал в день' : ''}${kind ? ' · ' + kind : ''}</div>`;
    $('#edDays').innerHTML = D.map(d => {
      const n = m.rows.filter(r => r.day === d).length;
      return `<button data-d="${d}" class="${d === ed.day ? 'on' : ''}">${d}<small>${n ? n + ' поз.' : '—'}</small></button>`;
    }).join('');
    const rows = m.rows.filter(r => r.day === ed.day);
    const total = rows.reduce((a, r) => ({ kcal: a.kcal + (r.kcal || 0), p: a.p + (r.p || 0), f: a.f + (r.f || 0), c: a.c + (r.c || 0) }), { kcal: 0, p: 0, f: 0, c: 0 });
    const dev = m.target && total.kcal ? Math.round((total.kcal / m.target - 1) * 100) : null;
    const groups = [];
    rows.forEach(r => { let g = groups.find(x => x.meal === r.meal); if (!g) { g = { meal: r.meal, rows: [], kcal: 0 }; groups.push(g); } g.rows.push(r); g.kcal += r.kcal || 0; });
    $('#edMeals').innerHTML = `<div class="day-total ${dev != null && Math.abs(dev) > 10 ? 'bad' : ''}"><span>Итого за день</span><span>${fmt(total.kcal)} ккал${dev != null ? ' (' + (dev > 0 ? '+' : '') + dev + '%)' : ''} · Б ${fmt(total.p)} Ж ${fmt(total.f)} У ${fmt(total.c)}</span></div>` +
      (groups.length ? groups.map(g => `
        <div class="ed-meal">
          <div class="meal-head"><span class="when">${esc(g.meal)}</span><span class="meal-kcal">${fmt(g.kcal)} ккал</span></div>
          ${g.rows.map(r => `<button class="ed-row" data-row="${r.row}">
            <span><span class="nm">${esc(r.item)}</span><br><span class="am">${fmt(r.qty, 2)} ${esc(r.unit)}</span></span>
            <span class="kc">${fmt(r.kcal)} ккал</span></button>`).join('')}
          <button class="ed-add" data-meal="${esc(g.meal)}">＋ добавить в «${esc(g.meal)}»</button>
        </div>`).join('') : '<div class="empty">В этот день пусто — добавьте продукт</div>');
    $('#edDelete').classList.toggle('hidden', m.kind === 'base');
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
    'Удалятся все его дни и назначения. Участники получат основное меню своего калоража.', async btn => {
      const r = await busy(btn, 'Удаляю…', () => api('adm_menu_delete', { code: ed.menu.code }));
      if (!r) return;
      S.variants = r.variants; S.assignments = r.assignments;
      closeSheets(); renderMenuList(); renderAssign(); showTab('menu'); toast('Меню удалено'); haptic('ok');
    }));

  /* ---------- Строка меню ---------- */
  function openRow(mode, r, meal) {
    row = { mode, r, meal: r ? r.meal : (meal || ''), unit: r ? r.unit : 'г' };
    $('#rowTitle').textContent = mode === 'edit' ? 'Изменить · ' + ed.day : 'Добавить · ' + ed.day;
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
    $('#rowUnits').innerHTML = S.units.map(u => `<button data-v="${u}" class="${u === row.unit ? 'on' : ''}">${u}</button>`).join('');
  }
  $('#rowMeals').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; row.meal = b.dataset.v; renderRowChips(); });
  $('#rowUnits').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; row.unit = b.dataset.v; renderRowChips(); rowCalc(); });
  const findItem = name => items.find(i => norm(i.name) === norm(name.trim()));
  function rowCalc() {
    const it = findItem($('#rowItem').value), q = num($('#rowQty').value);
    $('#rowInfo').textContent = it ? (it.type === 'r' ? 'Рецепт' : 'Продукт') + ' · ' + fmt(it.kcal) + ' ккал на 100 г' + (it.portion ? ' · 1 ' + (it.type === 'r' ? 'порц' : 'шт') + ' = ' + fmt(it.portion) + ' г' : '') : '';
    if (!it || q == null) { $('#rowCalc').textContent = ''; return; }
    const grams = row.unit === 'г' ? q : q * (it.portion || 0);
    $('#rowCalc').textContent = grams ? `≈ ${fmt(grams)} г · ${fmt(it.kcal * grams / 100)} ккал · Б ${fmt(it.p * grams / 100, 1)} Ж ${fmt(it.f * grams / 100, 1)} У ${fmt(it.c * grams / 100, 1)}`
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
    if (!it) return toast('Выберите продукт из списка');
    if (!row.meal) return toast('Выберите приём пищи');
    if (num($('#rowQty').value) == null) return toast('Укажите количество');
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

  /* ---------- Новая неделя ---------- */
  $('#newWeekBtn').addEventListener('click', () => {
    weekOptions('#wkWeek', 0);
    $('#wkTier').innerHTML = `<option value="">Все калоражи (${S.tiers.join(', ')})</option>` + S.tiers.map(t => `<option value="${t}">Только ${t} ккал</option>`).join('');
    $('#wkMsg').textContent = '';
    openSheet('#weekSheet');
  });
  $('#wkGo').addEventListener('click', async e => {
    const r = await busy(e.currentTarget, 'Создаю…', () => api('adm_new_week', { date: $('#wkWeek').value, tier: $('#wkTier').value }));
    if (!r) return;
    S.variants = r.variants; renderMenuList(); haptic('ok');
    $('#wkMsg').innerHTML = (r.created.length ? '✅ Создано: ' + r.created.map(esc).join(', ') : 'Ничего не создано') +
      (r.skipped.length ? '<br>Уже были: ' + r.skipped.map(esc).join(', ') : '');
  });

  /* ---------- Меню от ИИ ---------- */
  $('#aiBtn').addEventListener('click', () => {
    weekOptions('#aiWeek', 0);
    if (!$('#aiTier').value) $('#aiTier').value = S.tiers[2] || S.tiers[0] || 1500;
    $('#aiResult').innerHTML = '';
    openSheet('#aiSheet');
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
    const r = await busy(e.currentTarget, 'Готовлю…', () => api('adm_ai_prompt', { tier: $('#aiTier').value, protein: $('#aiProt').value, week: $('#aiWeek').value, wishes: $('#aiWish').value }));
    if (!r) return;
    if (await copyText(r.text)) { toast('Промпт скопирован — вставьте его в ИИ'); haptic('ok'); }
    else { $('#aiText').value = r.text; toast('Не удалось скопировать — текст в поле ниже, скопируйте вручную'); }
  });
  $('#aiImport').addEventListener('click', async e => {
    const text = $('#aiText').value.trim();
    if (!text) return toast('Вставьте ответ ИИ');
    const r = await busy(e.currentTarget, 'Загружаю…', () => api('adm_ai_import', { text }));
    if (!r) return;
    const li = a => '<ul>' + a.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
    if (!r.ok) {
      $('#aiResult').innerHTML = `<div class="ai-res bad"><b>Ничего не записано</b> — в ответе ИИ нужно поправить:${li(r.problems)}
        <button class="link" id="aiCopyProblems">📋 Скопировать список для ИИ</button></div>`;
      $('#aiCopyProblems').onclick = () => copyText('Исправь и пришли ответ целиком в том же формате:\n- ' + r.problems.join('\n- ')).then(() => toast('Скопировано'));
      return;
    }
    S.variants = r.variants; renderMenuList(); haptic('ok');
    $('#aiText').value = '';
    $('#aiResult').innerHTML = `<div class="ai-res ok"><b>✅ Загружено:</b> ${r.codes.map(esc).join(', ')}<br>Новых продуктов: ${r.products}, рецептов: ${r.recipes}` +
      (r.warnings.length ? `<br><br>⚠️ Проверьте:${li(r.warnings)}` : '') +
      `<br><button class="link" id="aiOpen">Открыть меню →</button></div>`;
    $('#aiOpen').onclick = () => { closeSheets(); openEditor(r.codes[0]); };
    refreshVariantsLater();
  });

  /* ---------- Назначения ---------- */
  function renderAssign() {
    weekOptions('#asWeek');
    $('#asTarget').innerHTML = S.targets.map(t => `<option>${esc(t)}</option>`).join('');
    $('#asVariant').innerHTML = S.variants.map(v => `<option value="${esc(v.code)}">${esc(v.code)}</option>`).join('');
    const cur = S.monday;
    $('#asList').innerHTML = S.assignments.length ? S.assignments.map(a => `
      <div class="as-item ${a.week < cur ? 'past' : ''}">
        <span><b>${esc(a.target)}</b><small>${ddmm(a.week)} – ${ddmm(addDays(a.week, 6))} · ${esc(a.variant)}</small></span>
        <button class="x" data-row="${a.row}" aria-label="Убрать">✕</button>
      </div>`).join('') : '<div class="empty">Назначений нет — все получают меню по калоражу</div>';
  }
  $('#asSave').addEventListener('click', async e => {
    const r = await busy(e.currentTarget, 'Сохраняю…', () => api('adm_assign', { week: $('#asWeek').value, target: $('#asTarget').value, variant: $('#asVariant').value }));
    if (!r) return;
    S.assignments = r.assignments; S.stats = r.stats; renderAssign(); renderStats(); haptic('ok');
    toast(r.replaced ? 'Назначение обновлено' : 'Назначено');
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

  /* ---------- Обучение (подробное, показывается при первом входе; «?» — снова) ---------- */
  const tourUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : 'demo';
  const TOUR_KEY = 'admin-tour-v1-' + tourUser;
  // el — что подсветить (селектор), tab — какую вкладку открыть перед этим; без el — карточка по центру
  const TOUR = [
    { ic: '👋', t: 'Это ваша админка', x: 'Всё, что есть в Google Таблице, — теперь с телефона: сводка по участникам, меню, назначения и продукты. Изменения сразу пишутся в ту же таблицу. Покажу, где что, — около минуты.' },
    { tab: 'stats', el: '.tabs button[data-tab="stats"]', ic: '📊', t: 'Сводка', x: 'Как дела у группы сегодня. Открывается первой.' },
    { tab: 'stats', el: '#kpi', ic: '🔢', t: 'Главные цифры', x: '<b>Сдали отчёт сегодня</b> — сколько из активных. <b>Без отчёта</b> — кто не отчитывается дольше порога из «Настроек» (обычно 2 дня). <b>Вне коридора</b> — калории сегодня отличаются от плана больше чем на ±15%. <b>Просрочен замер</b> — замера не было больше 7 дней. Красная цифра — есть на кого посмотреть.' },
    { tab: 'stats', el: '#statFilter', ic: '🔎', t: 'Фильтры', x: 'Показать только тех, кто без отчёта, вне коридора или с просроченным замером. «Все» — вернуть весь список.' },
    { tab: 'stats', el: '#people .person', ic: '👤', t: 'Карточка участника', x: 'Справа — калории за сегодня «факт / план» и отклонение (зелёным — в коридоре, красным — нет). Если отчёта ещё нет — серым план. Ниже — когда был отчёт и замер, вес, группа и какое меню у него на этой неделе. <b>Полоска слева</b>: красная — давно нет отчёта, оранжевая — вне коридора или просрочен замер.' },
    { tab: 'menu', el: '.tabs button[data-tab="menu"]', ic: '📋', t: 'Меню', x: 'Все меню: смотреть, менять продукты, создавать новые недели и загружать меню от ИИ.' },
    { tab: 'menu', el: '#menuList .m-item', ic: '🗂', t: 'Список меню', x: '<b>Основные</b> («1500 ккал (основное)») действуют каждую неделю. <b>На конкретную неделю</b> («1500 ккал · неделя 24.11.26») — только на свою неделю и главнее основного. Справа — насколько меню в среднем отличается от своего калоража: красным, если больше 10%. Нажмите на меню, чтобы открыть его.' },
    { tab: 'menu', ic: '✏️', t: 'Внутри меню', x: 'Сверху — дни недели, ниже — приёмы пищи и итог дня. <b>Нажмите на продукт</b> — можно заменить его (поиск по справочнику и рецептам), поменять количество, единицу (г, шт, порц) или приём пищи, удалить. <b>«+ добавить в Завтрак»</b> — новый продукт в этот приём. Калории считаются сразу. Меню на неделю можно удалить кнопкой внизу; основное — нельзя.' },
    { tab: 'menu', el: '#newWeekBtn', ic: '➕', t: 'Новая неделя', x: 'Копирует последнее меню каждого калоража на выбранную неделю (или только один калораж). Участники получат его сами — останется заменить нужные блюда.' },
    { tab: 'menu', el: '#aiBtn', ic: '🤖', t: 'Меню от ИИ', x: '1) Укажите калораж, белок и пожелания и нажмите «Скопировать промпт». 2) Вставьте его в ChatGPT или другой ИИ. 3) Ответ ИИ вставьте в поле и нажмите «Загрузить». Новые продукты и рецепты добавятся сами. Если в ответе ошибка — ничего не запишется, а список ошибок можно одной кнопкой скопировать обратно в ИИ.' },
    { tab: 'assign', el: '.tabs button[data-tab="assign"]', ic: '🗓', t: 'Назначения', x: 'Нужны, только если человеку или группе нужно не то меню, что подходит по калоражу. Без назначения каждый сам получает меню своего калоража.' },
    { tab: 'assign', el: '#tab-assign .card', ic: '🎯', t: 'Назначить меню', x: 'Выберите неделю, кому (все активные, группа или конкретный участник) и меню — «Назначить». Если на эту неделю у него уже было назначение, оно заменится. <b>Порядок</b>: личное → группа → все активные → по калоражу.' },
    { tab: 'assign', el: '#asList', ic: '✕', t: 'Список назначений', x: 'Назначения с прошлой недели и дальше. Крестик — убрать: человек снова получит меню по калоражу.' },
    { tab: 'products', el: '.tabs button[data-tab="products"]', ic: '🥦', t: 'Продукты', x: 'Справочник продуктов с КБЖУ на 100 г. По нему считаются все меню и рецепты.' },
    { tab: 'products', el: '.search-row', ic: '🔍', t: 'Поиск и новый продукт', x: 'Найдите продукт и нажмите на него, чтобы исправить КБЖУ — все меню пересчитаются. «➕ Новый» — добавить продукт: КБЖУ с упаковки или из FatSecret, для штучных (яйцо, яблоко) — вес 1 шт. Если калории не сходятся с Б/Ж/У, появится подсказка.' },
    { tab: 'stats', el: '#reloadBtn', ic: '⟳', t: 'Обновить', x: 'Если меняли что-то в самой таблице — нажмите, чтобы подтянуть свежие данные. Первая загрузка иногда идёт 5–15 секунд: так Google просыпается.' },
    { tab: 'stats', el: '#helpBtn', ic: '❓', t: 'Обучение снова', x: 'Эта кнопка снова покажет подсказки.' },
    { ic: '✅', t: 'Готово!', x: 'Таблица остаётся основой: всё, что вы меняете здесь, видно в ней, и наоборот. Анкеты, отчёты и оплаты по-прежнему приходят в чат с ботом.' }
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
