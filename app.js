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
      if (json.error) throw Object.assign(new Error(json.message || json.error), { code: json.error, id: json.id, anketa: json.anketa, anketaRequired: json.anketaRequired, anketaSent: json.anketaSent, pending: json.pending, temp: json.temp });
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

  // При загрузке — обычный круговой индикатор (анимация-авокадо убрана 21.11)
  async function init() {
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
      if (!state || ['not_registered', 'unpaid', 'expired', 'admin', 'unauthorized', 'finished', 'no_demo', 'maintenance'].includes(e.code)) {
        try { localStorage.removeItem(CACHE_KEY); } catch (err) {}
        showError(e);
      } else {
        // свежие данные не пришли — показываем сохранённые, но явно: от какого дня и кнопка «Обновить»
        const d = state && state.date ? parseDate(state.date) : null;
        const b = $('#staleBanner');
        b.innerHTML = `⚠️ Нет связи с сервером — показаны данные${d ? ' от ' + d.getDate() + ' ' + MONTHS[d.getMonth()] : ''}. <button class="link" onclick="location.reload()">Обновить</button>`;
        b.classList.remove('hidden');
      }
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
    const REQ = e.anketaRequired || [];
    const field = q => {
      const [key, label, type] = q;
      if (type.startsWith('select:')) return `<div class="choice"><input type="hidden" name="${key}">${type.slice(7).split('|').map(o => `<button type="button" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
      if (type === 'num') return `<input name="${key}" inputmode="decimal">`;
      // текстовые ответы — растущее поле: ширина строки, дальше растёт по мере набора
      return `<textarea name="${key}" class="grow" rows="${type === 'area' ? 3 : 2}"></textarea>`;
    };
    $('main').innerHTML = `<form class="card anketa" id="anketaForm" autocomplete="off">
      <h2>Анкета перед стартом</h2>
      <div class="muted" style="margin-top:4px">Поля со звёздочкой <span class="req">*</span> обязательные — по ним считается ваш калораж. Заполните до начала — тренер по ней рассчитает ваш калораж. Ответы увидит только тренер.</div>
      ${e.anketa.map(sec => `<h3>${esc(sec[0])}</h3>` + sec[1].map(q => `<div class="fld" data-k="${q[0]}"><div class="lbl">${esc(q[1])}${REQ.includes(q[0]) ? ' <span class="req">*</span>' : ''}</div>${field(q)}</div>`).join('')).join('')}
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
      $$('#anketaForm .fld.bad').forEach(x => x.classList.remove('bad'));
      const empty = e.anketa.flatMap(sec => sec[1]).filter(q => REQ.includes(q[0]) && !answers[q[0]]);
      const nums = { height: [120, 230], weight: [30, 250], age: [14, 90] };
      const wrong = e.anketa.flatMap(sec => sec[1]).filter(q => nums[q[0]] && answers[q[0]] && !(parseFloat(String(answers[q[0]]).replace(',', '.')) >= nums[q[0]][0] && parseFloat(String(answers[q[0]]).replace(',', '.')) <= nums[q[0]][1]));
      const badQ = empty.concat(wrong);
      if (badQ.length) {
        badQ.forEach(q => { const f = $('#anketaForm .fld[data-k="' + q[0] + '"]'); if (f) f.classList.add('bad'); });
        const first = $('#anketaForm .fld[data-k="' + badQ[0][0] + '"]'); if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast(empty.length ? 'Заполните обязательные поля со звёздочкой' : 'Проверьте: ' + wrong.map(q => q[1].replace(/,.*$/, '')).join(', '));
        return;
      }
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
    if (e.code === 'admin') { location.replace('admin.html'); return; }
    if (e.code === 'expired') {
      $('main').innerHTML = `<div class="error-box"><div class="big">🔒</div><h2>Доступ закрыт</h2><p class="muted">${esc(e.message).replace(/\n/g, '<br>')}</p>
        <button class="btn primary full" id="paidBtn" ${e.pending ? 'disabled' : ''}>${e.pending ? '⏳ Ждём подтверждения тренера' : '✅ Я оплатил(а)'}</button></div>`;
      $('.tabs').classList.add('hidden'); $('#sub').textContent = '';
      const b = $('#paidBtn');
      if (b) b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Отправляю…';
        try { await api('renew_paid'); b.textContent = '⏳ Ждём подтверждения тренера'; toast('Передал тренеру'); haptic('ok'); }
        catch (err) { b.disabled = false; b.textContent = '✅ Я оплатил(а)'; toast(err.message); }
      });
      return;
    }
    if (e.code === 'maintenance') return showMaintenance(e);
    if (e.code === 'not_registered' && e.anketa) return showAnketa(e);
    const msgs = {
      not_registered: ['🙋', 'Вас пока нет в группе', 'Тренер добавит вас — после этого откройте дневник снова.'],
      unpaid: ['💳', 'Доступ после оплаты', e.message],
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
    $("#adminBtn").classList.toggle("hidden", !data.admin);
    if (inTelegram && data.demo) data.demo = false;
    items = (data.items || []).map(a => ({ name: a[0], type: a[1], kcal: a[2], p: a[3], f: a[4], c: a[5], portion: a[6] || 0 }));
    const d = parseDate(data.date);
    $('#hello').textContent = 'Привет, ' + data.me.name + '!';
    $('#sub').textContent = `${DAYS[(d.getDay() + 6) % 7]}, ${d.getDate()} ${MONTHS[d.getMonth()]}` + (data.me.target ? ` · план ${fmt(data.me.target)} ккал` : '') +
      (data.access && data.access.to ? ` · подписка до ${parseDate(data.access.to).getDate()} ${MONTHS[parseDate(data.access.to).getMonth()]}` + (data.access.days >= 0 && data.access.days <= 7 ? ` (осталось ${data.access.days + 1} дн.)` : '') : '');
    $('#demoBanner').classList.toggle('hidden', !data.demo);
    // свежие данные пришли, пока человек уже заполняет отчёт — форму не перерисовываем, иначе всё введённое сотрётся
    if (!(repDirty && $('#reportForm').children.length)) renderReport();
    renderResults(); renderMenu(); renderProgress();
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
    $$('.sheet, .pop').forEach(s => s.classList.add('hidden'));
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

  // Блюда одного приёма пищи — в одну карточку (порядок приёмов — как в меню); i — номер блюда в дне для кнопки «Рецепт»
  function mealGroups(meals) {
    const groups = [], by = {};
    meals.forEach((x, i) => {
      let g = by[x.meal];
      if (!g) { g = by[x.meal] = { name: x.meal, kcal: 0, items: [] }; groups.push(g); }
      g.kcal += Number(x.kcal) || 0;
      g.items.push({ x, i });
    });
    return groups;
  }

  function renderMenu() {
    renderAiBox();
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
      (day.meals.length ? mealGroups(day.meals).map(g => `
        <div class="meal">
          <div class="meal-head"><span class="when">${esc(g.name)}</span><span class="meal-kcal">${fmt(g.kcal)} ккал</span></div>
          ${g.items.map(({ x, i }) => `
          <div class="dish-row">
            <div class="dish">${esc(x.item)}</div>
            <div class="nut">${fmt(x.qty, 2)} ${esc(x.unit)}${x.grams && x.unit !== 'г' ? ' · ≈' + fmt(x.grams) + ' г' : ''} · ${fmt(x.kcal)} ккал · Б ${fmt(x.p, 1)} Ж ${fmt(x.f, 1)} У ${fmt(x.c, 1)}</div>
            ${SHOW_RECIPES && state.recipes && state.recipes[x.item] ? `<div class="row"><button class="link" data-recipe="${i}">Рецепт →</button></div>` : ''}
          </div>`).join('')}
        </div>`).join('') : '<div class="empty">На этот день блюд нет</div>');
  }
  $('#dayChips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; menuDay = +b.dataset.d; renderMenu(); haptic(); });
  $('#dayMeals').addEventListener('click', e => {
    if (!state.menu) return;
    const day = state.menu.days[menuDay];
    const rb = e.target.closest('[data-recipe]');
    if (rb) openRecipe(day.meals[+rb.dataset.recipe]);
  });

  /* ---------- Своё меню от ИИ ---------- */
  // Участник пишет, что хочет есть → ИИ составляет меню на 7 дней (сервер проверяет и считает КБЖУ) → «Применить» на 1–4 недели поверх основного
  const dayMonth = s => { const d = parseDate(s); return d.getDate() + ' ' + MONTHS[d.getMonth()]; };
  const ymdAdd = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return ymd(d); };
  const mondayYmd = s => { const d = parseDate(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return ymd(d); };
  let aiRes = null, aiStart = null, aiWeeks = 1, aiDay = 0, aiBatch = 0, aiTier = 0;

  function renderAiBox() {
    const a = state.ai;
    if (!a) { $('#aiMenuBox').innerHTML = ''; return; }
    if (a.mode === 'chat') {
      // режим «Чат»: одна кнопка; если раньше ставили «своё меню» — можно вернуть меню тренера
      $('#aiMenuBox').innerHTML = (a.personal ? `<div class="card ai-box"><div>✨ Своё меню до ${dayMonth(a.personal.until)}</div><div class="row"><button class="link muted-link" id="aiCancelBtn">Вернуть меню тренера</button></div></div>` : '') +
        `<button class="btn full ai-open" id="aiChatBtn">💬 Составить меню с ИИ</button>`;
      $('#aiChatBtn').onclick = openChat;
    } else $('#aiMenuBox').innerHTML = a.personal
      ? `<div class="card ai-box"><div>✨ Своё меню до ${dayMonth(a.personal.until)}</div><div class="row"><button class="link" id="aiOpenBtn">Составить новое</button><button class="link muted-link" id="aiCancelBtn">Вернуть меню тренера</button></div></div>`
      : `<button class="btn full ai-open" id="aiOpenBtn">✨ Составить своё меню с ИИ</button>`;
    if ($('#aiOpenBtn')) $('#aiOpenBtn').onclick = () => { aiRes = null; renderAiForm(); openSheet('#aiMenuSheet'); };
    if ($('#aiCancelBtn')) $('#aiCancelBtn').onclick = async e => {
      if (!(await confirmAsk('Вернуть меню тренера? Своё меню перестанет показываться.'))) return;
      const b = e.currentTarget; b.disabled = true;
      try { const r = await api('ai_menu_cancel'); state.menu = r.menu; state.ai = r.ai; saveCache(); renderMenu(); toast('Вернули меню тренера'); haptic('ok'); }
      catch (err) { toast('⚠️ ' + err.message); b.disabled = false; }
    };
  }

  /* ---------- Чат с ИИ ---------- */
  // Участник пишет запрос как угодно, ИИ отвечает текстом с оформлением (Markdown); поправки — следующими сообщениями.
  let chatMsgs = [], chatBusy = false, chatShown = '', chatTarget = '', chatTimer = null;

  // Ответ «печатается»: сервер отдаёт уже написанное (partial), а здесь оно плавно дорисовывается по буквам
  const nearBottom = box => box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  function chatTick() {
    if (chatShown.length >= chatTarget.length) return;
    const left = chatTarget.length - chatShown.length, step = Math.max(2, Math.ceil(left / 25));
    chatShown = chatTarget.slice(0, chatShown.length + step);
    const box = $('#chatList'), follow = nearBottom(box);
    let live = $('#chatLive');
    if (!live || !live.classList.contains('md')) { renderChat('keep'); live = $('#chatLive'); }
    else live.innerHTML = md(chatShown);
    if (follow) box.scrollTop = box.scrollHeight;
  }
  function chatTyping(on) {
    clearInterval(chatTimer); chatTimer = null;
    if (on) { chatShown = ''; chatTarget = ''; chatTimer = setInterval(chatTick, 30); }
  }

  // Простой и безопасный Markdown: сначала экранируем всё, потом заголовки, списки, жирный/курсив, короткие таблицы, линии
  function mdInline(s) {
    return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function md(src) {
    const L = esc(src).replace(/\r/g, '').split('\n'), out = [];
    const cells = r => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    let i = 0, m;
    while (i < L.length) {
      const t = L[i].trim();
      if (!t) { i++; continue; }
      if (/^```/.test(t)) { const buf = []; i++; while (i < L.length && !/^```/.test(L[i].trim())) buf.push(L[i++]); i++; out.push('<pre>' + buf.join('\n') + '</pre>'); continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) { const lv = Math.min(4, Math.max(2, m[1].length)); out.push(`<div class="md-h${lv}">${mdInline(m[2].replace(/#+$/, ''))}</div>`); i++; continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { out.push('<hr>'); i++; continue; }
      if (t[0] === '|') {
        const rows = []; while (i < L.length && L[i].trim()[0] === '|') rows.push(cells(L[i++].trim()));
        const sep = r => r.every(c => /^:?-{2,}:?$/.test(c));
        const head = rows.length > 1 && sep(rows[1]) ? rows[0] : null, body = rows.filter((r, k) => !sep(r) && !(head && k === 0));
        // широкая таблица (3+ колонки, например «Приём | Продукты | Как готовить | КБЖУ») — карточками: на телефоне так читается
        if (head && head.length >= 3) {
          out.push('<div class="md-rows">' + body.map(r => '<div class="md-row"><div class="md-row-t">' + mdInline(r[0] || '') + '</div>' +
            r.slice(1).map((c, k) => (c ? '<div class="md-row-f"><span>' + mdInline(head[k + 1] || '') + '</span>' + mdInline(c) + '</div>' : '')).join('') + '</div>').join('') + '</div>');
          continue;
        }
        out.push('<div class="md-table"><table>' + (head ? '<tr>' + head.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr>' : '') +
          body.map(r => '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') + '</table></div>');
        continue;
      }
      if (/^[-*•]\s+/.test(t)) { const it = []; while (i < L.length && /^\s*[-*•]\s+/.test(L[i])) it.push(L[i++].trim().replace(/^[-*•]\s+/, '')); out.push('<ul>' + it.map(x => '<li>' + mdInline(x) + '</li>').join('') + '</ul>'); continue; }
      if (/^\d+[.)]\s+/.test(t)) { const it = []; while (i < L.length && /^\s*\d+[.)]\s+/.test(L[i])) it.push(L[i++].trim().replace(/^\d+[.)]\s+/, '')); out.push('<ol>' + it.map(x => '<li>' + mdInline(x) + '</li>').join('') + '</ol>'); continue; }
      if (/^&gt;\s?/.test(t)) { const it = []; while (i < L.length && /^&gt;\s?/.test(L[i].trim())) it.push(L[i++].trim().replace(/^&gt;\s?/, '')); out.push('<blockquote>' + it.map(mdInline).join('<br>') + '</blockquote>'); continue; }
      const p = []; while (i < L.length && L[i].trim() && !/^(#{1,6}\s|[-*•]\s|\d+[.)]\s|\||```|&gt;|-{3,}$|\*{3,}$)/.test(L[i].trim())) p.push(L[i++].trim());
      if (!p.length) { out.push('<p>' + mdInline(t) + '</p>'); i++; continue; }
      out.push('<p>' + p.map(mdInline).join('<br>') + '</p>');
    }
    return out.join('');
  }

  function renderChat(scroll) {
    const box = $('#chatList'), keepTop = box.scrollTop;
    const hello = `<div class="msg ai hint">Напишите, какое меню хотите — как удобно. Например: <i>«Меню на 3 дня, готовлю раз в 3 дня, без сахара»</i>.<br><br>ИИ ответит меню с граммовками, рецептами и КБЖУ${state.me.target ? ' под вашу норму ' + fmt(state.me.target) + ' ккал' : ''}. Что поправить — пишите следующим сообщением.</div>`;
    box.innerHTML = (chatMsgs.length ? '' : hello) + chatMsgs.map(m => m.role === 'user'
      ? `<div class="msg me">${esc(m.text).replace(/\n/g, '<br>')}</div>`
      : `<div class="msg ai md">${md(m.text)}</div>`).join('') +
      (chatBusy ? (chatShown ? `<div class="msg ai md" id="chatLive">${md(chatShown)}</div>` : `<div class="msg ai typing" id="chatLive"><span class="dots"><i></i><i></i><i></i></span></div>`) : '');
    $('#chatLeft').textContent = state.ai ? 'Осталось сообщений сегодня: ' + state.ai.left : '';
    $('#chatSend').disabled = chatBusy;
    if (scroll === 'keep') box.scrollTop = keepTop;
    else if (scroll === 'end') box.scrollTop = box.scrollHeight;
    else if (scroll === 'last') { const last = box.lastElementChild; if (last) box.scrollTop = last.offsetTop - box.offsetTop - 8; }
  }

  async function openChat() {
    openSheet('#aiChatSheet');
    renderChat('end');
    try { const r = await api('ai_chat_state'); chatMsgs = r.messages; state.ai.left = r.left; renderChat('end'); }
    catch (e) { toast('⚠️ ' + e.message); }
  }

  async function chatSend() {
    const ta = $('#chatText'), text = ta.value.trim();
    if (!text || chatBusy) return;
    chatMsgs.push({ role: 'user', text }); ta.value = ''; autoGrow(ta);
    chatBusy = true; chatTyping(true); renderChat('end');
    try {
      const s = await api('ai_chat_send', { text });
      state.ai.left = s.left;
      let r = null;
      for (let i = 0; i < 400 && !r; i++) {
        await new Promise(res => setTimeout(res, 700));
        const x = await api('ai_chat_status', { job: s.job });
        if (x.status === 'done') r = x;
        else if (x.partial) chatTarget = x.partial;
      }
      if (!r) throw new Error('ИИ не успел ответить — напишите ещё раз');
      // допечатать до конца быстро и показать как обычное сообщение
      chatTarget = r.message.text;
      while (chatShown.length < chatTarget.length) { chatTick(); await new Promise(res => setTimeout(res, 15)); }
      chatTyping(false);
      chatMsgs.push(r.message);
      if (typeof r.prefs === 'string') state.ai.prefs = r.prefs;
      saveCache(); haptic('ok');
      chatBusy = false; renderChat('keep');
    } catch (e) {
      chatTyping(false);
      chatBusy = false;
      if (e.code === 'ai_limit' || e.code === 'empty') { chatMsgs.pop(); ta.value = text; }
      renderChat('end'); toast('⚠️ ' + e.message);
    }
  }
  $('#chatSend').addEventListener('click', chatSend);
  $('#chatNew').addEventListener('click', async () => {
    if (chatBusy || !chatMsgs.length) return;
    if (!(await confirmAsk('Начать новый чат? Эта переписка удалится. Что вы любите и не едите — ИИ помнит.'))) return;
    try { await api('ai_chat_reset'); chatMsgs = []; renderChat('end'); haptic(); } catch (e) { toast('⚠️ ' + e.message); }
  });

  // калоражи на выбор: 1200–3500 через 50 и норма участника, если её нет в этом ряду
  function aiTiers() {
    const own = Math.round(state.me.target) || 0, list = [];
    for (let t = 1200; t <= 3500; t += 50) list.push(t);
    if (own && !list.includes(own)) list.push(own);
    return list.sort((a, b) => a - b);
  }

  function renderAiForm(wishes) {
    $('#aiMenuBody').innerHTML = `
      <label class="f-lbl">Что вы хотите есть?</label>
      <textarea id="aiWishes" class="grow" rows="4" placeholder="Например: простое меню из продуктов, которые есть в любом магазине, и чтобы готовить было несложно. Люблю гречку с курицей и сырники. Не ем молоко.">${esc(wishes || '')}</textarea>
      <label class="f-lbl" style="margin-top:12px">Как часто вы хотите готовить?</label>
      <div class="seg pick" id="aiBatchSeg">${[[0, 'Каждый день'], [2, 'Раз в 2 дня'], [3, 'Раз в 3 дня']].map(([n, t]) => `<button data-b="${n}" class="${aiBatch === n ? 'on' : ''}">${t}</button>`).join('')}</div>
      <label class="f-lbl" style="margin-top:12px" for="aiTier">Калорий в день</label>
      <select id="aiTier">${aiTiers().map(t => `<option value="${t}" ${t === (aiTier || Math.round(state.me.target)) ? 'selected' : ''}>${fmt(t)} ккал${t === Math.round(state.me.target) ? ' · ваша норма' : ''}</option>`).join('')}</select>
      <div class="muted" style="margin:6px 0 12px">ИИ составит меню на неделю. Попыток на сегодня: ${state.ai.left}</div>
      <button class="btn primary full" id="aiGo">Составить меню</button>`;
    $('#aiBatchSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; aiBatch = +b.dataset.b; $$('#aiBatchSeg button').forEach(x => x.classList.toggle('on', x === b)); haptic(); };
    $('#aiTier').onchange = e => { aiTier = +e.target.value; };
    $('#aiGo').onclick = () => aiRun({ wishes: $('#aiWishes').value, batch: aiBatch, tier: +$('#aiTier').value });
    renderAiPrefsBtn();
  }

  // «?» у крестика: что ИИ запомнил о вкусах участника (видно, только если памятка есть); можно поправить
  // Открывается поверх окна «Своё меню»: фон темнеет и размывается; закрыть — ✕ или тап по фону
  function renderAiPrefsBtn() {
    $('#aiPrefsBtn').classList.toggle('hidden', !state.ai.prefs);
    if (!state.ai.prefs) closeAiPrefs();
  }
  const closeAiPrefs = () => $('#aiPrefsPop').classList.add('hidden');
  $('#aiPrefsClose').addEventListener('click', closeAiPrefs);
  $('#aiPrefsPop').addEventListener('click', e => { if (e.target === e.currentTarget) closeAiPrefs(); });
  $('#aiPrefsBtn').addEventListener('click', () => {
    $('#aiPrefsBody').innerHTML = `<div class="muted">Учту в следующих меню. Можно исправить или стереть.</div>
      <textarea id="aiPrefs" class="grow" rows="4">${esc(state.ai.prefs)}</textarea>
      <button class="btn primary full" id="aiPrefsSave" style="margin-top:10px">Сохранить</button>`;
    $('#aiPrefsPop').classList.remove('hidden'); haptic();
    $('#aiPrefsSave').onclick = async e => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const r = await api('ai_prefs_save', { prefs: $('#aiPrefs').value });
        state.ai.prefs = r.prefs; saveCache(); closeAiPrefs(); renderAiPrefsBtn(); toast('Сохранено'); haptic('ok');
      } catch (err) { toast('⚠️ ' + err.message); b.disabled = false; }
    };
  });

  async function aiRun(data) {
    const body = $('#aiMenuBody');
    const back = aiRes;
    body.innerHTML = `<div class="ai-wait"><div class="spin"></div><b>ИИ составляет меню…</b><div class="muted">Обычно до минуты. Не закрывайте приложение.</div></div>`;
    try {
      const s = await api('ai_menu_start', data);
      state.ai.left = s.left;
      let r = null;
      for (let i = 0; i < 100 && !r; i++) {
        await new Promise(res => setTimeout(res, 3000));
        const x = await api('ai_menu_status', { job: s.job });
        if (x.status === 'done') r = x;
      }
      if (!r) throw new Error('ИИ не успел ответить — попробуйте ещё раз');
      aiRes = r; aiDay = 0; state.ai.draft = true;
      if (typeof r.prefs === 'string') { state.ai.prefs = r.prefs; saveCache(); renderAiPrefsBtn(); }
      renderAiResult(); haptic('ok');
    } catch (e) {
      toast('⚠️ ' + e.message);
      if (back) { aiRes = back; renderAiResult(); } else renderAiForm(data.wishes);
    }
  }

  function renderAiResult() {
    const mon = mondayYmd(state.date), next = ymdAdd(mon, 7);
    if (!aiStart || (aiStart !== mon && aiStart !== next)) aiStart = mon;
    const d = aiRes.days[aiDay];
    const end = ymdAdd(aiStart, 7 * aiWeeks - 1);
    $('#aiMenuBody').innerHTML = `
      <div class="days" id="aiDays">${aiRes.days.map((x, i) => `<button data-d="${i}" class="${i === aiDay ? 'on' : ''}">${x.day}<small>${fmt(x.total.kcal)}</small></button>`).join('')}</div>
      <div class="day-total"><span>${esc(d.full)}</span><span>${fmt(d.total.kcal)} ккал · Б ${fmt(d.total.p)} Ж ${fmt(d.total.f)} У ${fmt(d.total.c)}</span></div>
      ${d.meals.map(g => `<div class="meal"><div class="meal-head"><span class="when">${esc(g.name)}</span><span class="meal-kcal">${fmt(g.kcal)} ккал</span></div>` +
        g.items.map(x => `<div class="dish-row"><div class="dish">${esc(x.item)}</div><div class="nut">${fmt(x.qty, 2)} ${esc(x.unit)}${x.grams ? ' · ≈' + fmt(x.grams) + ' г' : ''} · ${fmt(x.kcal)} ккал</div>${aiRes.recipes && aiRes.recipes[x.item] ? `<div class="row"><button class="link" data-airecipe="${esc(x.item)}" data-qty="${x.qty}" data-unit="${esc(x.unit)}">Рецепт →</button></div>` : ''}</div>`).join('') + '</div>').join('')}
      <label class="f-lbl" style="margin-top:14px">Что поправить?</label>
      <textarea id="aiFix" class="grow" rows="2" placeholder="Например: в среду вместо рыбы курица"></textarea>
      <button class="btn full" id="aiFixGo" style="margin-top:8px">Поправить (попыток: ${state.ai.left})</button>
      <label class="f-lbl" style="margin-top:16px">С какой недели</label>
      <div class="seg pick" id="aiStartSeg"><button data-s="${mon}" class="${aiStart === mon ? 'on' : ''}">Эта неделя</button><button data-s="${next}" class="${aiStart === next ? 'on' : ''}">Следующая</button></div>
      <label class="f-lbl">На сколько недель</label>
      <div class="seg pick" id="aiWeeksSeg">${[1, 2, 3, 4].map(n => `<button data-w="${n}" class="${aiWeeks === n ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div class="muted" style="margin-bottom:10px">Меню будет стоять с ${dayMonth(aiStart)} по ${dayMonth(end)}, потом снова меню тренера.</div>
      <button class="btn primary full" id="aiApply">Применить</button>`;
    $$('[data-airecipe]').forEach(b => { b.onclick = () => openAiRecipe({ item: b.dataset.airecipe, qty: +b.dataset.qty, unit: b.dataset.unit }); });
    $('#aiDays').onclick = e => { const b = e.target.closest('button'); if (!b) return; aiDay = +b.dataset.d; renderAiResult(); haptic(); };
    $('#aiStartSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; aiStart = b.dataset.s; renderAiResult(); haptic(); };
    $('#aiWeeksSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; aiWeeks = +b.dataset.w; renderAiResult(); haptic(); };
    $('#aiFixGo').onclick = () => { const fix = $('#aiFix').value.trim(); if (!fix) return toast('Напишите, что поправить'); aiRun({ fix }); };
    $('#aiApply').onclick = async e => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Применяю…';
      try {
        const r = await api('ai_menu_apply', { start: aiStart, weeks: aiWeeks });
        state.menu = r.menu; state.ai = r.ai; saveCache();
        renderMenu.first = true; renderMenu(); closeSheets();
        toast('Готово! Своё меню до ' + dayMonth(r.until)); haptic('ok');
      } catch (err) { toast('⚠️ ' + err.message); b.disabled = false; b.textContent = 'Применить'; }
    };
  }

  function openRecipe(x) {
    $('#rTitle').textContent = x.item;
    $('#rBody').innerHTML = recipeHtml(x, state.recipes[x.item]);
    openSheet('#recipeSheet');
  }
  // Рецепт из предпросмотра «Своего меню» — окошком поверх, меню под ним не закрывается
  function openAiRecipe(x) {
    const r = aiRes && aiRes.recipes && aiRes.recipes[x.item];
    if (!r) return;
    $('#aiRTitle').textContent = x.item;
    $('#aiRBody').innerHTML = recipeHtml(x, r);
    $('#aiRecipePop').classList.remove('hidden'); haptic();
  }
  $('#aiRClose').addEventListener('click', () => $('#aiRecipePop').classList.add('hidden'));
  $('#aiRecipePop').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); });

  function recipeHtml(x, r) {
    // во сколько раз ингредиентов меньше/больше, чем в целом рецепте, при этой порции
    const portions = x.unit === 'г' && r.portion ? x.qty / r.portion : Number(x.qty) || 1;
    const k = portions / (r.portions || 1);
    // Состав на порцию участника в формате тренера: «продукт — граммы — ккал» (ккал по справочнику)
    let total = 0;
    const rows = r.items.map(([n, g]) => {
      const grams = g * k, it = items.find(i => i.name === n);
      const kcal = it ? grams * it.kcal / 100 : null;
      if (kcal != null) total += kcal;
      return `<div class="ing"><span>${esc(n)}</span><span class="ing-r"><b>${fmt(grams)} г</b>${kcal != null ? ` · ${fmt(kcal)} ккал` : ''}</span></div>`;
    }).join('');
    // заготовка на несколько порций — сколько продуктов брать на всю готовку
    const batch = (r.portions || 1) > 1 ? `<div class="r-h">На всю заготовку · ${fmt(r.portions, 2)} порц.</div>` +
      r.items.map(([n, g]) => `<div class="ing"><span>${esc(n)}</span><span class="ing-r"><b>${fmt(g)} г</b></span></div>`).join('') : '';
    return `<div class="r-h" style="margin-top:4px">Ваша порция</div><div>${rows}</div>` +
      (total ? `<div class="ing ing-total"><span>Итого</span><span class="ing-r"><b>${fmt(total)} ккал</b></span></div>` : '') +
      (r.desc ? `<div class="r-h">Как готовить</div><div class="r-desc">${esc(r.desc)}</div>` : '') + batch;
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
      }).join('')}</div>` : '<h2>Замеров пока нет</h2><div class="muted" style="margin-top:4px">Раз в неделю, по воскресеньям утром, натощак.</div>';
    // фото замеров — только в окне периода (воскресенье 4-й недели); цифры — всегда
    const mw = state.measureWindow;
    let gate = $('#measureGate');
    const formCard = $('#measureForm').closest('.card');
    if (!gate) { gate = document.createElement('div'); gate.id = 'measureGate'; gate.className = 'card'; formCard.parentNode.insertBefore(gate, formCard); }
    const photoClosed = !!(mw && !mw.free && !mw.open);
    const dm = d => `${parseDate(d).getDate()} ${MONTHS[parseDate(d).getMonth()]}`;
    if (mw && !mw.free && mw.open) {
      gate.innerHTML = mw.done
        ? `<h2>✅ Фото замеров за этот период загружены</h2>`
        : `<h2>📸 Пора отправить фото замеров!</h2><div class="muted" style="margin-top:4px">Сегодня можно загрузить фото замеров — 4 фото с разных сторон. Форма ниже. Открыто до ${dm(mw.closesOn)} включительно.</div>`;
      gate.classList.remove('hidden');
    } else gate.classList.add('hidden');
    const ph = $('#mPhotos') && $('#mPhotos').closest('.full');
    if (ph) ph.classList.toggle('hidden', photoClosed);
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
      state.measures = r.measures; if (r.weights) state.weights = r.weights; if (r.measureWindow) state.measureWindow = r.measureWindow;
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
      if (rm) { pk.list.splice(+rm.dataset.rm, 1); pk.render(); if (pk.onChange) pk.onChange(); return; }
      if (e.target.closest('.add-ph')) input.click();
    });
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []).slice(0, max - pk.list.length);
      input.value = '';
      for (const f of files) { try { pk.list.push(await compress(f)); } catch (err) { toast(err.message); } }
      pk.render();
      if (pk.onChange) pk.onChange();
    });
    pk.reset = () => { pk.list = []; pk.render(); };
    pk.render();
    return pk;
  }

  /* ---------- Отчёт дня (формат тренера) ---------- */
  let repDay = 'today';
  let repDirty = false; // в форме отчёта уже что-то введено
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
    repDirty = false;
    renderPlan();
    if (state.reportOpen === false && repDay === 'today') {
      const startedToday = state.me.start && state.me.start >= state.date;
      if (!(state.daily || {}).yesterday && !startedToday) repDay = 'yesterday';
      else {
        $('#repDay').innerHTML = `<div class="rep-head"><div class="t">Отчёт за новый день откроется в <span>${state.reportOpenHour || 8}:00</span></div><div class="s">Сейчас ещё рано — день только начался.${startedToday ? '' : ' Отчёт за вчера уже отправлен ✓'}</div></div>`;
        $('#repStatus').innerHTML = ''; $('#reportForm').innerHTML = '';
        return;
      }
    }
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
          <div class="s">Опоздавший отчёт запишется на ${label}</div>${state.reportOpen === false ? '' : '<button class="back" id="goToday">← к отчёту за сегодня</button>'}</div>`;
    $('#repStatus').innerHTML = r
      ? `<div class="rep-status ok">✓ Отчёт за ${label} отправлен${r.sentAt ? ' в ' + esc(r.sentAt) : ''}. Можно исправить и отправить заново.</div>`
      : '';
    const v = r || {};
    const val = k => { const x = v[k]; return x == null || x === '' ? '' : String(x).replace('.', ','); };
    const hunger = v.hunger || '';
    $('#reportForm').innerHTML = `
      <div class="fld"><div class="lbl">📎 Дневник FatSecret <small>${state.fsRequired ? 'обязательно' : 'ссылка на экспорт'}</small></div>
        <input name="fatsecret" type="text" inputmode="url" value="${esc(v.fatsecret || '')}" placeholder="Вставьте ссылку из FatSecret" autocomplete="off">
        <div id="fsBox">${state.fsRequired && !v.fatsecret ? fsHowTo : ''}</div></div>
      <div class="fld${state.fsRequired ? ' hidden' : ''}" id="fsPhotos"><div class="lbl">📷 Нет ссылки? Приложите скриншоты FatSecret <small>до 3</small></div>
        <div class="photos" id="repPhotos"></div></div>
      <div id="manualKbju" class="hidden">
        <div class="fs-or">Перепишите итог дня со скриншота</div>
        <div class="fld"><div class="lbl">🔥 Калории за день</div>
          <input name="kcal" inputmode="numeric" placeholder="например, 1650" value="${val('kcal')}"></div>
        <div class="fld"><div class="lbl">БЖУ, г <small>белок — обязательно, если тренер выдал планку</small></div>
          <div class="row3">
            <label>Белки<input name="p" inputmode="decimal" value="${val('p')}"></label>
            <label>Жиры<input name="f" inputmode="decimal" value="${val('f')}"></label>
            <label>Углеводы<input name="c" inputmode="decimal" value="${val('c')}"></label>
          </div></div>
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
        <label>☕ Чай/кофе, кружек<input name="tea" inputmode="numeric" value="${val('tea')}" placeholder="без добавок"></label>
        <label>🥦 Растительность, г<input name="veg" inputmode="numeric" value="${val('veg')}" placeholder="овощи и фрукты"></label>
      </div></div>
      <div class="fld steps-fld">
        <label>👣 Шаги<input name="steps" inputmode="numeric" value="${val('steps')}" placeholder="например, 8000"></label>
        <label class="toggle"><input type="checkbox" name="stepsTr" ${v.stepsTr === 'с тренировкой' ? 'checked' : ''}> шаги с учётом тренировки</label></div>
      <div class="fld"><div class="lbl">🏋️ Была ли тренировка</div>
        <div class="choice yn" id="trainingYN">${['Да', 'Нет'].map(o => `<button type="button" data-v="${o}" class="${trainVal(v.training) === o ? 'on' : ''}">${o === 'Да' ? '✅ Да' : '❌ Нет'}</button>`).join('')}</div>
        <input type="hidden" name="training" value="${esc(trainVal(v.training))}"></div>
      <div class="fld"><div class="lbl">💬 Комментарий для тренера</div>
        <textarea name="note" class="grow" rows="3" placeholder="необязательно">${esc(v.note || '')}</textarea></div>
      <button class="btn primary full" type="submit">${r ? 'Отправить исправленный отчёт' : 'Отправить отчёт за ' + (repDay === 'today' ? 'сегодня' : 'вчера, ' + label)}</button>`;
    repPhotos = photoPicker($('#repPhotos'), 3, 'скриншот');
    repPhotos.onChange = updateManual;
    // исправление старого отчёта без ссылки — цифры, введённые вручную, показываем сразу
    manualForEdit = !!(r && !v.fatsecret && v.kcal);
    fsData = null;
    if (v.fatsecret) checkFs(v.fatsecret); else updateManual();
  }

  // «Была ли тренировка»: Да / Нет (старые ответы текстом: «нет», «-» → Нет; любой другой текст → Да)
  function trainVal(t) { const s = String(t || '').trim().toLowerCase(); if (!s) return ''; return /^(нет|no|-|−|0)$/.test(s) ? 'Нет' : 'Да'; }

  /* ---------- FatSecret: цифры дня по ссылке экспорта ---------- */
  let fsPending = false, fsData = null, fsTimer = null, fsReq = 0, fsBusy = false, manualForEdit = false;
  const fsHowTo = '<div class="fs-how">Где взять: FatSecret → <b>Дневник</b> → ⋯ → <b>Экспорт</b> → скопировать ссылку и вставить сюда.</div>';
  // Поля калорий/БЖУ — только когда есть скриншоты, а рабочей ссылки нет. Скриншоты не нужны, если ссылка сработала.
  function updateManual() {
    const m = $('#manualKbju'), ph = $('#fsPhotos');
    if (!m || !ph) return;
    const hasPhotos = repPhotos && repPhotos.list.length > 0;
    // ссылка обязательна — ни скриншотов, ни ручного ввода
    if (state.fsRequired) { ph.classList.add('hidden'); m.classList.add('hidden'); return; }
    ph.classList.toggle('hidden', !!fsData || fsBusy);
    m.classList.toggle('hidden', !!fsData || fsBusy || !(hasPhotos || manualForEdit));
  }
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
    fsData = null; fsPending = false;
    const id = ++fsReq;
    fsBusy = false;
    if (!url) { box.innerHTML = state.fsRequired ? fsHowTo : ''; updateManual(); return; }
    if (!/fatsecret\./i.test(url)) { box.innerHTML = '<div class="fs-err">Это не ссылка FatSecret. В приложении FatSecret: Дневник → Экспорт → скопировать ссылку.</div>'; updateManual(); return; }
    box.innerHTML = '<div class="fs-load">Загружаю дневник из FatSecret…</div>';
    fsBusy = true; updateManual();
    try {
      const r = await api('fatsecret', { url, day: repDay });
      if (id !== fsReq) return;
      fsBusy = false; fsData = r.fs;
      box.innerHTML = fsCard(r.fs);
      updateManual(); haptic();
    } catch (err) {
      if (id !== fsReq) return;
      fsBusy = false;
      if (err.temp) { fsPending = true; box.innerHTML = '<div class="fs-load">⏳ FatSecret сейчас не отвечает. Заполните остальное и нажмите «Отправить отчет».</div>'; updateManual(); return; }
      box.innerHTML = `<div class="fs-err">${esc(err.message)}</div>`;
      updateManual();
    }
  }
  $('#reportForm').addEventListener('input', () => { repDirty = true; });
  $('#reportForm').addEventListener('click', e => { if (e.target.closest('button:not([type=submit])')) repDirty = true; });
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
    const yn = e.target.closest('#trainingYN button');
    if (yn) {
      const was = yn.classList.contains('on');
      $$('#trainingYN button').forEach(x => x.classList.toggle('on', !was && x === yn));
      $('#reportForm [name=training]').value = was ? '' : yn.dataset.v;
      haptic(); return;
    }
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
    if (state.fsRequired && !fsData && !fsPending) { toast(fsBusy ? 'Подождите, загружаю дневник из FatSecret…' : 'Вставьте ссылку на экспорт FatSecret'); return; }
    if (!fsData && !fsPending && !data.photos.length && !manualForEdit) { toast(fsBusy ? 'Подождите, загружаю дневник из FatSecret…' : 'Вставьте ссылку FatSecret или приложите скриншоты'); return; }
    if (!fsPending && !(parseFloat(data.kcal) > 0)) { toast('Укажите калории за день — перепишите со скриншота'); return; }
    if (!fsPending && state.me.tPr && !data.p && !(await confirmAsk('Белок не указан. Отправить без него?'))) return;
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true; btn.textContent = data.photos.length ? 'Отправляю со скриншотами…' : 'Отправляю…';
    try {
      const r = await api('saveReport', data);
      if (r.queued) { haptic('ok'); toast('Отчёт отправлен тренеру ✅'); btn.disabled = false; btn.textContent = 'Отправить отчёт тренеру'; return; }
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
    const tab = h === 'today' || h === 'add' ? 'report' : h === 'rations' ? 'menu' : h; // старые ссылки на рационы → меню
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
  $('#adminBtn').addEventListener('click', () => { location.href = 'admin.html'; });
  window.addEventListener('resize', () => { if (!$('#tour').classList.contains('hidden')) showTourStep(); });

  init();
})();
