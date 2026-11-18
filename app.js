/* 汉字 каждый час — приложение работает полностью на телефоне.
 * Слова и прогресс хранятся в IndexedDB (в телефоне), поэтому доступны офлайн.
 */
(function () {
  'use strict';

  const SRS = window.SRS;
  const DB_NAME = 'hz-hourly';
  const DB_VERSION = 1;
  const DEFAULT_SETTINGS = {
    intervalMin: 60,      // перерыв между напоминаниями
    sessionSize: 10,      // карточек (вопросов) за тренировку
    nextAt: 0,            // когда напомнить в следующий раз
    installedAt: 0,
    lastNotifiedAt: 0,
  };

  // =================== IndexedDB ===================
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('cards')) d.createObjectStore('cards', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      let out;
      try { out = fn(t.objectStore(store)); } catch (e) { reject(e); return; }
      const value = out && out.result !== undefined ? out.result : out;
      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(value); } };
      t.oncomplete = settle;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
      // в некоторых окружениях транзакция завершается раньше установки oncomplete
      if (t._completed) settle();
    }));
  }

  const all = (store) => tx(store, 'readonly', (s) => s.getAll());
  const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
  const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

  // =================== состояние ===================
  let cards = [];
  let settings = { ...DEFAULT_SETTINGS };
  let session = { queue: [], index: 0, done: 0, correct: 0 };
  let parsed = { rows: [], bad: [] };
  let pendingPhoto = null;

  // =================== утилиты ===================
  // надёжный поиск: querySelector, а если он не сработал — по id
  const $ = (sel) => document.querySelector(sel) ||
    (sel.charAt(0) === '#' ? document.getElementById(sel.slice(1)) : null);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `c_${Date.now()}_${Math.random().toString(16).slice(2)}`);

  let toastTimer = null;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }

  function photoUrl(photo) {
    if (!photo) return '';
    if (typeof photo === 'string') return photo;
    if (!photo.__url) photo.__url = URL.createObjectURL(photo);
    return photo.__url;
  }

  function releaseUrls() {
    cards.forEach((c) => {
      if (c.photo && typeof c.photo !== 'string' && c.photo.__url) {
        URL.revokeObjectURL(c.photo.__url);
        delete c.photo.__url;
      }
    });
  }

  /** Уменьшает фото, чтобы телефон не переполнялся. */
  function shrinkImage(file, maxSide = 1400, quality = 0.8) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  // =================== загрузка данных ===================
  async function loadAll() {
    const stored = await storeAll('settings');
    const map = {};
    stored.forEach((s) => { map[s.key] = s.value; });
    settings = { ...DEFAULT_SETTINGS, ...map };
    if (!settings.seededAt) await seed();
    cards = (await storeAll('cards')).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    // подстраховка: если стартовые слова почему-то не легли — грузим встроенный список
    if (!cards.length && Array.isArray(window.SEED_WORDS) && window.SEED_WORDS.length) {
      const now = Date.now();
      for (let i = 0; i < window.SEED_WORDS.length; i += 1) {
        await addCard({ ...window.SEED_WORDS[i], createdAt: now + i });
      }
      cards = (await storeAll('cards')).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    }
  }

  async function seed() {
    try {
      const res = await fetch('seed.json', { cache: 'no-store' });
      if (!res.ok) return;
      const list = await res.json();
      const now = Date.now();
      for (let i = 0; i < list.length; i += 1) {
        const w = list[i];
        // слова приходят постепенно: по три сразу, дальше каждые 30 минут
        const due = now + Math.floor(i / 3) * 30 * 60 * 1000;
        await storePut('cards', {
          id: uid(), ...w, stage: 0, due, correct: 0, wrong: 0, archived: 0, createdAt: now + i,
        });
      }
      await saveSetting('seededAt', now);
    } catch (e) {
      console.warn('seed failed', e);
    }
  }

  async function saveSetting(key, value) {
    settings[key] = value;
    await storePut('settings', { key, value });
  }

  // =================== режим «без базы» ===================
  // Если IndexedDB недоступна (приватный режим, старая версия Chrome),
  // приложение всё равно работает — карточки живут в памяти этой вкладки.
  let memoryOnly = false;
  let memoryStore = { cards: new Map(), settings: new Map() };
  let seededV = false;

  /** Совместимая обёртка хранилища: IndexedDB или память. */
  async function storeAll(name) {
    if (memoryOnly) return [...memoryStore[name].values()].map((v) => ({ ...v }));
    try {
      return await all(name);
    } catch (e) {
      console.warn('fallback to memory', e);
      memoryOnly = true;
      markMemory();
      return storeAll(name);
    }
  }

  async function storePut(name, value) {
    if (memoryOnly) {
      const k = name === 'settings' ? value.key : value.id;
      memoryStore[name].set(k, { ...value });
      return;
    }
    try {
      await put(name, value);
    } catch (e) {
      console.warn('fallback to memory', e);
      memoryOnly = true;
      markMemory();
      memoryStore[name].set(name === 'settings' ? value.key : value.id, { ...value });
    }
  }

  async function storeDel(name, key) {
    if (memoryOnly) { memoryStore[name].delete(key); return; }
    try { await del(name, key); } catch (e) { memoryOnly = true; memoryStore[name].delete(key); }
  }

  function markMemory() {
    const el = $('#homeSub');
    if (el && !memoryOnlyShown) {
      memoryOnlyShown = true;
      el.textContent = (el.textContent || '') + ' · режим без сохранения (приватный режим браузера)';
    }
  }
  let memoryOnlyShown = false;

  // =================== экраны ===================
  const VIEWS = ['home', 'session', 'done', 'add', 'list', 'photo', 'settings'];

  /** Экраны открываем вручную: ошибка classList в старом движке
   *  раньше валила весь запуск приложения. */
  function go(name) {
    VIEWS.forEach((v) => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.hidden = v !== name;
    });
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.go === name || (name === 'home' && t.dataset.go === 'home');
      t.classList.toggle('active', on);
    });
    if (name === 'home') renderHome();
    if (name === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }

  function renderHome() {
    const now = Date.now();
    const live = cards.filter((c) => !c.archived);
    const due = SRS.dueCount(live, now);
    $('#homeSub').textContent = live.length === 0
      ? 'Добавь первое слово — и начнём.'
      : due > 0
        ? `Готовы к повторению: ${due} · всего слов: ${live.length}`
        : `Все повторены. Следующее — ${SRS.describeDue(Math.min(...live.map((c) => c.due || 0)), now)}`;
    // подпись кнопки не меняем: иначе её «съедают» некоторые пути (иначе кнопка выглядит мёртвой)
    $('#btnStart').textContent = 'Начать тренировку';
    $('#wordCount').textContent = live.length ? `(${live.length})` : '';

    const pill = $('#duePill');
    pill.hidden = !(due > 0);
    if (due > 0) pill.textContent = `${due} на повторение`;

    const list = $('#wordList');
    list.innerHTML = '';
    if (!live.length) {
      list.innerHTML = '<li class="empty" style="cursor:default">Пока пусто. Нажми «＋ Добавить».</li>';
      return;
    }
    live.slice().reverse().forEach((c) => {
      const li = document.createElement('li');
      const url = photoUrl(c.photo);
      li.innerHTML = `
        ${url ? `<img class="thumb" src="${url}" alt="">` : ''}
        <span class="ch"></span>
        <span class="meta"><div class="py"></div><div class="ru"></div></span>
        <span class="when"></span>`;
      li.querySelector('.ch').textContent = c.hanzi;
      li.querySelector('.py').textContent = c.pinyin || '';
      li.querySelector('.ru').textContent = c.meaning || '';
      li.querySelector('.when').textContent = SRS.isDue(c, now) ? 'сейчас' : SRS.describeDue(c.due, now);
      li.addEventListener('click', () => openCardSheet(c));
      list.appendChild(li);
    });
  }

  // =================== тренировка: пишу от руки, программа проверяет ===================
  let pad = null;        // { canvas, ctx, strokes, drawing }
  let currentQuestion = null;
  let currentResult = null;
  let answeredCurrent = false;

  const PAD_SIZE = 600;  // внутреннее разрешение холста

  function initPad() {
    if (pad) return pad;
    const canvas = document.getElementById('pad');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    pad = { canvas, ctx, strokes: [], drawing: false };
    const toLocal = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return { x: (ev.clientX - rect.left) * scaleX, y: (ev.clientY - rect.top) * scaleY };
    };
    const start = (ev) => {
      if (answeredCurrent) return;
      ev.preventDefault();
      pad.drawing = true;
      pad.strokes.push([toLocal(ev)]);
      drawPad();
    };
    const move = (ev) => {
      if (!pad.drawing) return;
      ev.preventDefault();
      const stroke = pad.strokes[pad.strokes.length - 1];
      const p = toLocal(ev);
      const last = stroke[stroke.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 2) return;
      stroke.push(p);
      drawPad();
    };
    const end = (ev) => {
      if (!pad.drawing) return;
      if (ev.preventDefault) ev.preventDefault();
      pad.drawing = false;
    };
    if (window.PointerEvent) {
      canvas.addEventListener('pointerdown', (ev) => { if (canvas.setPointerCapture) { try { canvas.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ } } start(ev); });
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
    } else {
      canvas.addEventListener('touchstart', (ev) => start(ev.touches[0]), { passive: false });
      canvas.addEventListener('touchmove', (ev) => move(ev.touches[0]), { passive: false });
      canvas.addEventListener('touchend', end);
      canvas.addEventListener('mousedown', start);
      canvas.addEventListener('mousemove', move);
      canvas.addEventListener('mouseup', end);
    }
    drawPad();
    return pad;
  }

  function drawPad() {
    if (!pad) return;
    const { ctx } = pad;
    const w = pad.canvas.width;
    const h = pad.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#1f2d3a';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    pad.strokes.forEach((stroke) => {
      if (!stroke.length) return;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i += 1) ctx.lineTo(stroke[i].x, stroke[i].y);
      if (stroke.length === 1) ctx.lineTo(stroke[0].x + 1, stroke[0].y + 1);
      ctx.stroke();
    });
  }

  function erasePad() {
    if (!pad) return;
    pad.strokes = [];
    drawPad();
    hideHintLayer();
  }

  function padBox() {
    // данные черт в шкале 0..1000 → площадь холста с отступом 8%
    const margin = PAD_SIZE * 0.08;
    return { x: margin, y: margin, size: PAD_SIZE - margin * 2 };
  }

  /** Черты всего слова: для «我们» — черты «我», затем черты «们» со сдвигом. */
  function mediansFor(card) {
    const table = window.STROKES;
    if (!table || !card) return null;
    if (table[card.hanzi]) return table[card.hanzi].medians;
    const chars = Array.from(card.hanzi || '').filter((ch) => table[ch]);
    if (!chars.length) return null;
    const yRange = (ms) => {
      const ys = ms.flat().map(([, y]) => y);
      return { min: Math.min(...ys), max: Math.max(...ys) };
    };
    // одиночный иероглиф заполняет квадрат целиком; в слове делим ширину поровну
    const cell = 1000 / chars.length;
    const out = [];
    chars.forEach((ch, index) => {
      const ms = table[ch].medians;
      const { min, max } = yRange(ms);
      const span = Math.max(1, max - min);
      const scale = 1000 / span;
      const dx = index * cell + cell * 0.06;
      ms.forEach((stroke) => {
        out.push(stroke.map(([x, y]) => [dx + (x / 1000) * cell * 0.88, (y - min) * scale]));
      });
    });
    return out;
  }

  function strokesForMedians(medians) {
    const box = padBox();
    const k = box.size / 1000;
    return medians.map((stroke) => stroke.map(([x, y]) => ({ x: box.x + x * k, y: box.y + y * k })));
  }

  /** Задание на текущий вопрос. */
  function buildQuestion(card, prevType) {
    const type = SRS.pickQuestionType(card, Math.random, prevType);
    const q = SRS.questionFor(card, type);
    return { id: card.id, type, prompt: q.prompt, ask: q.ask, kind: q.kind };
  }

  function startSession() {
    if (!cards.filter((c) => !c.archived).length) { go('add'); return; }
    const size = SRS.sessionSize(cards, settings.sessionSize);
    const queue = SRS.pickSession(cards, size, Date.now(), (c) => !c.archived);
    const items = [];
    let prevType = null;
    queue.forEach((c, i) => {
      const q = buildQuestion(cards.find((x) => x.id === c.id) || c, prevType);
      prevType = q.type;
      items.push(q);
    });
    session = { queue: items, index: 0, done: 0, correct: 0 };
    go('session');
    renderSessionCard();
  }

  function cardById(id) { return cards.find((c) => c.id === id); }

  function renderSessionCard() {
    const q = session.queue[session.index];
    if (!q) { finishSession(); return; }
    const card = cardById(q.id);
    if (!card) { session.index += 1; renderSessionCard(); return; }

    currentQuestion = q;
    currentResult = null;
    answeredCurrent = false;
    const typeInfo = SRS.QUESTION_TYPES.find((t) => t.id === q.type) || {};
    $('#modePill').textContent = typeInfo.label || '';
    $('#sessionProgress').textContent = `вопрос ${session.index + 1} из ${session.queue.length}`;
    $('#faceHint').textContent = q.ask;
    $('#faceHanzi').textContent = q.prompt;
    $('#faceHanzi').style.fontSize = q.kind === 'pinyin' ? '2.2rem' : '';

    erasePad();
    $('#verdict').hidden = true;
    $('#verdict').className = 'verdict';
    $('#verdict').textContent = '';
    $('#answer').hidden = true;
    $('#answerActions').hidden = true;
    $('#btnCheck').hidden = false;
    $('#btnErase').hidden = false;
    $('#btnHint').hidden = false;
    $('#btnCheck').textContent = 'Проверить';
    $('#padHint').textContent = q.kind === 'pinyin' ? 'напиши пиньинь пальцем' : 'напиши иероглиф пальцем';

    initPad();
  }

  /** Проверка ответа — без звука, только текст на экране. */
  function checkAnswer() {
    const q = currentQuestion;
    if (!q || answeredCurrent) return;
    const card = cardById(q.id);
    if (!card) return;
    const strokes = pad ? pad.strokes : [];
    let verdict;
    let result;

    if (q.kind === 'pinyin') {
      // пиньинь пальцем не распознать — просим набрать и показываем ответ
      const typed = window.prompt('Набери пиньинь:', '');
      if (typed == null) return;
      result = PinyinCheck.compare(typed, card.pinyin);
      verdict = PinyinCheck.verdict(result);
    } else {
      const medians = mediansFor(card);
      if (!medians) {
        // нет данных черт — считаем верным по факту «написал и проверил»
        result = { result: strokes.length ? 'correct' : 'empty', expected: card.hanzi };
        verdict = { ok: strokes.length > 0, text: strokes.length ? '✅ Правильно' : 'Сначала нарисуй иероглиф' };
      } else {
        result = HanziCheck.compare(strokes, padBox(), medians);
        verdict = HanziCheck.verdict(result);
      }
    }

    if (!verdict.ok && verdict.text.indexOf('Сначала') === 0) {
      showVerdict(verdict.ok, verdict.text);
      return;
    }

    currentResult = { q, card, result, verdict };
    answeredCurrent = true;
    showVerdict(verdict.ok, verdict.text);
    showAnswerDetails(card, result);
    // считаем ответ сразу, на диск пишем в фоне
    countAnswer(card, verdict.ok);
    storePut('cards', cards.find((c) => c.id === card.id)).catch((e) => console.warn('не сохранилось', e));
  }

  function showVerdict(ok, text) {
    const box = $('#verdict');
    box.hidden = false;
    box.className = 'verdict ' + (ok ? 'ok' : 'bad');
    box.textContent = text;
  }

  function showAnswerDetails(card, result) {
    $('#ansHanzi').textContent = card.hanzi;
    $('#ansPinyin').textContent = card.pinyin || '';
    $('#ansMeaning').textContent = card.meaning || '';
    const expected = result && result.expected ? `Правильно: ${result.expected}` : '';
    $('#ansExample').textContent = [expected, card.example_zh, card.example_ru].filter(Boolean).join(' · ');
    $('#ansNote').textContent = card.note || '';
    $('#answer').hidden = false;
    $('#btnCheck').hidden = true;
    $('#btnHint').hidden = true;
    $('#btnErase').hidden = true;
    $('#answerActions').hidden = false;
    $('#btnNext').textContent = session.index + 1 >= session.queue.length ? 'Итог →' : 'Дальше →';
  }

  /** Считает ответ (ступень, срок, статистика по типу) — синхронно. */
  function countAnswer(card, ok) {
    const now = Date.now();
    const r = SRS.next(card.stage, ok, now);
    const qStats = { ...(card.q || {}) };
    const prev = qStats[currentQuestion.type] || { right: 0, wrong: 0 };
    qStats[currentQuestion.type] = { right: prev.right + (ok ? 1 : 0), wrong: prev.wrong + (ok ? 0 : 1) };
    const updated = {
      ...card,
      stage: r.stage,
      due: r.due,
      correct: (card.correct || 0) + (ok ? 1 : 0),
      wrong: (card.wrong || 0) + (ok ? 0 : 1),
      lastSeen: now,
      q: qStats,
    };
    const i = cards.findIndex((c) => c.id === card.id);
    if (i >= 0) cards[i] = updated; else cards.push(updated);
    session.done += 1;
    if (ok) session.correct += 1;
    return updated;
  }

  async function saveAnswer(card, ok) {
    const updated = countAnswer(card, ok);
    try {
      await storePut('cards', updated);
    } catch (e) {
      console.warn('не сохранилось', e);
    }
    return updated;
  }

  function nextQuestion() {
    if (!session.queue.length) { finishSession(); return; }
    // последний вопрос — итог тренировки и расписание следующей
    if (session.index + 1 >= session.queue.length) {
      scheduleNext(Date.now() + settings.intervalMin * 60 * 1000);
      session.index += 1;
      finishSession();
      return;
    }
    session.index += 1;
    renderSessionCard();
  }

  function showHint() {
    const q = currentQuestion;
    const card = q && cardById(q.id);
    if (!card) return;
    const layer = document.getElementById('hintLayer');
    const medians = mediansFor(card);
    if (q.kind === 'pinyin' || !medians || !layer) {
      toast(q.kind === 'pinyin' ? `Подсказка: ${card.pinyin}` : `Подсказка: ${card.hanzi}`);
      return;
    }
    const ctx = layer.getContext('2d');
    ctx.clearRect(0, 0, layer.width, layer.height);
    ctx.strokeStyle = 'rgba(201, 71, 61, 0.35)';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokesForMedians(medians).forEach((stroke) => {
      ctx.beginPath();
      stroke.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    });
    layer.hidden = false;
  }

  function hideHintLayer() {
    const layer = document.getElementById('hintLayer');
    if (!layer) return;
    const ctx = layer.getContext('2d');
    ctx.clearRect(0, 0, layer.width, layer.height);
    layer.hidden = true;
  }

  function finishSession() {
    const now = Date.now();
    const live = cards.filter((c) => !c.archived);
    const nextDue = live.length ? Math.min(...live.map((c) => c.due || 0)) : 0;
    $('#doneSub').textContent = session.done
      ? `Проверено карточек: ${session.done} · правильно: ${session.correct}. ${nextDue ? `Следующая тренировка — ${SRS.describeDue(nextDue, now)}.` : ''}`
      : 'Вопросов пока нет.';
    go('done');
  }
  // =================== напоминания ===================
  async function scheduleNext(at) {
    await saveSetting('nextAt', at);
    renderScheduleState();
    armTimer(at);
    if (notifPermission() === 'granted') await armSystemTrigger(at);
  }

  function armTimer(at) {
    clearTimeout(window.__alarm);
    const ms = at - Date.now();
    if (ms > 0 && ms < 24 * 3600 * 1000) {
      window.__alarm = setTimeout(() => {
        if (Date.now() >= (settings.nextAt || 0)) fireReminder();
      }, Math.max(1000, ms));
    }
  }

  function armSystemTrigger(at) {
    return navigator.serviceWorker.ready
      .then((reg) => {
        if (!('showTrigger' in Notification.prototype)) return;
        return reg.showNotification('汉字: 60 секунд', {
          tag: 'hz-reminder',
          body: reminderBody(),
          icon: 'icons/icon-192.png',
          showTrigger: new TimestampTrigger(at),
          data: { url: './?from=reminder' },
        }).catch((e) => console.warn('showTrigger', e));
      })
      .catch(() => {});
  }

  function notifPermission() {
    return 'Notification' in window ? Notification.permission : 'unsupported';
  }

  function reminderBody() {
    const next = SRS.pickSession(cards, 1, Date.now(), (c) => !c.archived)[0];
    if (!next) return 'Добавь новое слово?';
    return `${next.hanzi}${next.pinyin ? ' · ' + next.pinyin : ''} — ${next.meaning}`;
  }

  async function fireReminder() {
    await saveSetting('lastNotifiedAt', Date.now());
    if (document.visibilityState === 'visible') {
      if (cards.filter((c) => !c.archived).length && !session.queue.length) startSession();
      await scheduleNext(Date.now() + settings.intervalMin * 60 * 1000);
      return;
    }
    if (notifPermission() === 'granted') {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification('汉字: 60 секунд', {
          tag: 'hz-reminder', body: reminderBody(), icon: 'icons/icon-192.png',
          data: { url: './?from=reminder' },
        });
      } catch (e) { console.warn(e); }
    }
    await scheduleNext(Date.now() + settings.intervalMin * 60 * 1000);
  }

  // пока приложение открыто, проверяем время раз в 30 секунд
  setInterval(() => {
    if (!settings.nextAt) return;
    if (Date.now() >= settings.nextAt && Date.now() - settings.lastNotifiedAt > 60 * 1000) fireReminder();
  }, 30 * 1000);

  async function requestNotifications() {
    if (notifPermission() === 'unsupported') { toast('Этот браузер не поддерживает уведомления'); return; }
    if (notifPermission() === 'denied') {
      toast('Разреши уведомления в настройках Chrome для этого сайта');
      return;
    }
    const p = await Notification.requestPermission();
    renderSettings();
    if (p === 'granted') {
      toast('Уведомления включены');
      await scheduleNext(Date.now() + settings.intervalMin * 60 * 1000);
    }
  }

  function renderSettings() {
    const state = $('#notifState');
    const perm = notifPermission();
    if (perm === 'granted') {
      state.textContent = `Уведомления включены. Сайт позовёт раз в ${humanInterval()}.`;
      $('#btnNotif').textContent = 'Уведомления включены ✓';
      $('#btnTestNotif').hidden = false;
    } else if (perm === 'denied') {
      state.textContent = 'Уведомления запрещены. Chrome → ⚙ → Уведомления сайтов → разреши для этой страницы.';
      $('#btnNotif').textContent = 'Как разрешить';
      $('#btnTestNotif').hidden = true;
    } else {
      state.textContent = 'Пока выключены. Без них приложение не сможет позвать тебя, когда оно закрыто.';
      $('#btnNotif').textContent = 'Включить уведомления';
      $('#btnTestNotif').hidden = true;
    }
    $('#setInterval').value = String(settings.intervalMin);
    $('#setSize').value = String(settings.sessionSize);
    renderScheduleState();
  }

  function humanInterval() {
    const m = settings.intervalMin;
    if (m === 60) return 'час';
    return m < 60 ? `${m} минут` : `${m / 60} часа`;
  }

  function renderScheduleState() {
    const el = $('#scheduleState');
    if (!el) return;
    if (!settings.nextAt) { el.textContent = 'Следующее напоминание ещё не назначено.'; return; }
    const when = new Date(settings.nextAt);
    el.textContent = 'Следующее напоминание: ' +
      when.toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // =================== карточка слова ===================
  function openCardSheet(card) {
    $('#sheetTitle').textContent = card.hanzi;
    const body = $('#sheetBody');
    body.innerHTML = `
      <p class="muted small">Ступень ${card.stage || 0} из ${SRS.MAX_STAGE} · ждёт: ${SRS.describeDue(card.due, Date.now())}</p>
      <form class="form" id="sheetForm">
        <label>Иероглиф<input name="hanzi" lang="zh"></label>
        <label>Пиньинь<input name="pinyin"></label>
        <label>Перевод<input name="meaning"></label>
        <label>Пример (китайский)<input name="example_zh" lang="zh"></label>
        <label>Пример (перевод)<input name="example_ru"></label>
        <label>Заметка<input name="note"></label>
        <div class="row">
          <button type="submit" class="btn primary">💾 Сохранить</button>
          <button type="button" class="btn ghost" id="sheetNow">🔔 Сейчас</button>
          <button type="button" class="btn ghost" id="sheetDel" style="color:var(--red-dark)">🗑 Удалить</button>
        </div>
      </form>`;
    const f = body.querySelector('#sheetForm');
    ['hanzi', 'pinyin', 'meaning', 'example_zh', 'example_ru', 'note'].forEach((k) => { f[k].value = card[k] || ''; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const updated = { ...card };
      ['hanzi', 'pinyin', 'meaning', 'example_zh', 'example_ru', 'note'].forEach((k) => { updated[k] = f[k].value.trim(); });
      await storePut('cards', updated);
      const i = cards.findIndex((c) => c.id === card.id);
      if (i >= 0) cards[i] = updated;
      closeSheet();
      toast('Сохранено');
      renderHome();
    });
    body.querySelector('#sheetNow').addEventListener('click', async () => {
      const updated = { ...card, due: Date.now() };
      await storePut('cards', updated);
      const i = cards.findIndex((c) => c.id === card.id);
      if (i >= 0) cards[i] = updated;
      closeSheet();
      startSession();
    });
    body.querySelector('#sheetDel').addEventListener('click', async () => {
      await storeDel('cards', card.id);
      cards = cards.filter((c) => c.id !== card.id);
      closeSheet();
      toast('Удалено');
      renderHome();
    });
    $('#sheet').hidden = false;
  }

  function closeSheet() { $('#sheet').hidden = true; }

  // =================== добавление ===================
  async function addCard(data) {
    const key = SRS.keyOf(data);
    const existing = cards.find((c) => SRS.keyOf(c) === key && !c.archived);
    if (existing) {
      const merged = { ...existing, ...data, id: existing.id };
      await storePut('cards', merged);
      const i = cards.findIndex((c) => c.id === existing.id);
      if (i >= 0) cards[i] = merged;
      return { updated: true, card: merged };
    }
    const now = Date.now();
    const card = {
      id: uid(),
      hanzi: data.hanzi,
      pinyin: data.pinyin || '',
      meaning: data.meaning || '',
      example_zh: data.example_zh || '',
      example_ru: data.example_ru || '',
      note: data.note || '',
      photo: data.photo || null,
      stage: 0, due: now, correct: 0, wrong: 0, archived: 0, createdAt: now,
    };
    await storePut('cards', card);
    cards.push(card);
    return { updated: false, card };
  }

  async function submitAdd(e) {
    e.preventDefault();
    const f = e.target;
    const hanzi = f.hanzi.value.trim();
    if (!hanzi) return;
    let photo = null;
    const file = f.photo.files && f.photo.files[0];
    if (file) photo = await shrinkImage(file);
    const res = await addCard({
      hanzi,
      pinyin: f.pinyin.value.trim(),
      meaning: f.meaning.value.trim(),
      example_zh: f.example_zh.value.trim(),
      example_ru: f.example_ru.value.trim(),
      note: f.note.value.trim(),
      photo,
    });
    const msg = $('#addMsg');
    msg.className = 'msg ok';
    msg.textContent = res.updated ? `«${hanzi}» уже было — обновила данные.` : `«${hanzi}» добавлено.`;
    f.reset();
    renderHome();
    setTimeout(() => go('home'), 700);
  }

  // =================== списком ===================
  function parseListText() {
    parsed = SRS.parseList($('#listText').value);
    const box = $('#parseResult');
    box.innerHTML = '';
    parsed.rows.forEach((r) => {
      const d = document.createElement('div');
      d.className = 'ok';
      d.textContent = `${r.hanzi}  ${r.pinyin || '—'}  ${r.meaning || ''}`;
      box.appendChild(d);
    });
    parsed.bad.forEach((b) => {
      const d = document.createElement('div');
      d.className = 'bad';
      d.textContent = `Строка ${b.line}: не разобрала «${b.text}» — раздели поля через |`;
      box.appendChild(d);
    });
    $('#importRow').hidden = parsed.rows.length === 0;
    $('#btnImport').textContent = `Добавить ${parsed.rows.length} слов`;
  }

  async function doImport() {
    let added = 0;
    let updated = 0;
    for (const r of parsed.rows) {
      const res = await addCard(r);
      if (res.updated) updated += 1; else added += 1;
    }
    $('#listText').value = '';
    $('#parseResult').innerHTML = '';
    $('#importRow').hidden = true;
    renderHome();
    toast(`Добавлено ${added}${updated ? `, обновлено ${updated}` : ''}`);
    go('home');
  }

  // =================== фото ===================
  async function handlePhotoFiles(files) {
    if (!files || !files.length) return;
    const file = files[0];
    if (file.size > 20 * 1024 * 1024) { toast('Фото слишком большое — сделай поменьше'); return; }
    pendingPhoto = await shrinkImage(file);
    const grid = $('#photoPreview');
    grid.innerHTML = '';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(pendingPhoto);
    grid.appendChild(img);
    $('#formPhoto').hidden = false;
  }

  async function submitPhoto(e) {
    e.preventDefault();
    if (!pendingPhoto) return;
    const hanzi = $('#fPhotoHanzi').value.trim() || $('#fPhotoName').value.trim() || 'фото';
    const res = await addCard({
      hanzi,
      pinyin: '',
      meaning: $('#fPhotoMeaning').value.trim() || $('#fPhotoName').value.trim(),
      photo: pendingPhoto,
    });
    pendingPhoto = null;
    e.target.reset();
    $('#formPhoto').hidden = true;
    $('#photoPreview').innerHTML = '';
    renderHome();
    toast(res.updated ? 'Карточка с фото обновлена' : 'Фото добавлено');
    go('home');
  }

  // =================== календарь ===================
  function buildIcs() {
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    const now = new Date();
    const start = new Date(now.getTime() + 5 * 60 * 1000);
    const local = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}T${pad(start.getHours())}${pad(start.getMinutes())}00`;
    const hourly = Math.max(1, Math.round(settings.intervalMin / 60));
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//hz-hourly//RU',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:${uid()}@hz-hourly`,
      `DTSTAMP:${fmt(now)}`,
      `DTSTART:${local}`,
      `DURATION:PT${settings.intervalMin}M`,
      `RRULE:FREQ=HOURLY;INTERVAL=${hourly}`,
      'SUMMARY:汉字 60 секунд — повторение слов',
      'DESCRIPTION:Открой приложение и повтори 3-5 карточек.',
      'BEGIN:VALARM',
      'TRIGGER:PT0M',
      'ACTION:DISPLAY',
      'DESCRIPTION:汉字: 60 секунд',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
  }

  function downloadIcs() {
    const blob = new Blob([buildIcs()], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '汉字-каждый-час.ics';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Файл сохранён → открой его → «Добавить в Google Календарь»');
  }

  // =================== копия ===================
  function exportJson() {
    const dump = {
      app: 'hz-hourly',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { ...settings },
      cards: cards.map((c) => ((c.photo && typeof c.photo !== 'string') ? { ...c, photo: null } : c)),
    };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `汉字-копия-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Копия сохранена в «Загрузки»');
  }

  async function importJsonFile(file) {
    const text = await file.text();
    let dump;
    try { dump = JSON.parse(text); } catch (e) { toast('Файл повреждён или это не копия'); return; }
    const list = Array.isArray(dump) ? dump : dump.cards;
    if (!Array.isArray(list)) { toast('В файле нет карточек'); return; }
    let n = 0;
    for (const c of list) {
      if (!c || !c.hanzi) continue;
      const card = { ...c, id: c.id || uid(), hanzi: String(c.hanzi) };
      await storePut('cards', card);
      const i = cards.findIndex((x) => x.id === card.id);
      if (i >= 0) cards[i] = card; else cards.push(card);
      n += 1;
    }
    if (dump.settings && typeof dump.settings === 'object') {
      for (const [k, v] of Object.entries(dump.settings)) {
        if (k in DEFAULT_SETTINGS) await saveSetting(k, v);
      }
    }
    renderHome();
    toast(`Восстановлено карточек: ${n}`);
  }

  async function wipeAll() {
    await tx('cards', 'readwrite', (s) => s.clear());
    await tx('settings', 'readwrite', (s) => s.clear());
    location.reload();
  }

  // =================== обработчики ===================
  // защита: если элемента нет, не падаем и не теряем остальные обработчики
  const on = (sel, evt, fn) => { const el = $(sel); if (el) el.addEventListener(evt, fn); };

  function bind() {
    // Делегирование: даже если какой-то элемент не найден, кнопки продолжают работать.
    document.addEventListener('click', (e) => {
      const target = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
      if (!target || !target.closest) return;
      const nav = target.closest('[data-go]');
      if (nav) { e.preventDefault(); go(nav.dataset.go); return; }

      const btn = target.closest(
        '#btnStart, #btnStartBottom, #btnEndSession, #btnCheck, #btnNext, #btnErase, #btnHint, '
        + '#btnParseList, #btnImport, #btnPhotoCancel, #btnNotif, #btnTestNotif, #btnIcs, '
        + '#btnExport, #btnImportFile, #sheetClose',
      );
      if (!btn) return;
      switch (btn.id) {
        case 'btnStart':
        case 'btnStartBottom': startSession(); return;
        case 'btnEndSession': finishSession(); break;
        case 'btnCheck': checkAnswer(); break;
        case 'btnNext': nextQuestion(); break;
        case 'btnErase': erasePad(); break;
        case 'btnHint': showHint(); break;
        case 'btnParseList': parseListText(); break;
        case 'btnImport': doImport(); break;
        case 'btnPhotoCancel':
          pendingPhoto = null;
          $('#formPhoto').hidden = true;
          $('#photoPreview').innerHTML = '';
          break;
        case 'btnNotif': requestNotifications(); break;
        case 'btnTestNotif': fireReminder(); break;
        case 'btnIcs': downloadIcs(); break;
        case 'btnExport': exportJson(); break;
        case 'btnImportFile': $('#importFile').click(); break;
        case 'sheetClose': closeSheet(); break;
        default: break;
      }
    });

    // письмо от руки: холст подключается один раз, дальше — кнопки
    initPad();

    on('#formAdd', 'submit', submitAdd);
    on('#photoInput', 'change', (e) => handlePhotoFiles(e.target.files));
    on('#formPhoto', 'submit', submitPhoto);
    on('#setInterval', 'change', async (e) => {
      await saveSetting('intervalMin', Number(e.target.value));
      await scheduleNext(Date.now() + settings.intervalMin * 60 * 1000);
      toast('Напоминание перенесено');
    });
    on('#setSize', 'change', (e) => saveSetting('sessionSize', Number(e.target.value)));
    on('#importFile', 'change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importJsonFile(f);
      e.target.value = '';
    });
    on('#setWipe', 'change', (e) => {
      if (!e.target.checked) return;
      if (confirm('Удалить все слова и прогресс?')) wipeAll();
      else e.target.checked = false;
    });
    on('#sheet', 'click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      renderHome();
      if (settings.nextAt && Date.now() >= settings.nextAt && Date.now() - settings.lastNotifiedAt > 60 * 1000) {
        fireReminder();
      }
    });
  }

  // =================== старт ===================
  // Пути запуска для экрана диагностики (на телефоне консоли нет)
  const trace = [];
  const step = (name) => { trace.push(name); };

  async function init() {
    step('bind');
    bind();
    try {
      step('sw');
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw', e));
      }
      step('loadAll');
      await loadAll();
      step('settings');
      await saveSetting('installedAt', settings.installedAt || Date.now());
      step('render');
      window.__HZ_READY__ = true;
      renderHome();
      go('home');
      step('done');

      if (new URLSearchParams(location.search).get('from') === 'reminder') {
        history.replaceState({}, '', location.pathname);
        startSession();
      } else if (cards.filter((c) => !c.archived).length && !settings.nextAt) {
        await scheduleNext(Date.now() + settings.intervalMin * 60 * 1000);
      }
    } catch (e) {
      console.error(e);
      showStartupError(e);
    }
  }

  function showStartupError(e) {
    lastError = { message: String((e && e.message) || e), step: trace[trace.length - 1] || '?' };
    const sub = $('#homeSub');
    if (!sub) return;
    let why = 'Не удалось загрузить данные.';
    const protocol = String(location.protocol);
    if (protocol === 'http:') {
      why = 'Не удалось загрузить данные. Проверьте, что ноутбук включён, '
        + 'что телефон в той же Wi-Fi и нет VPN.';
    }
    sub.innerHTML = `${why}<br><br>Ошибка: <b>${escapeHtml(lastError.message)}</b><br>`
      + `Шаг: ${escapeHtml(lastError.step)} · ${escapeHtml(protocol)}<br>`
      + `<small>Скопируйте эту строку и пришлите её.</small>`;
    sub.style.color = 'var(--red-dark)';
  }

  let lastError = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  window.addEventListener('beforeunload', releaseUrls);

  // Для проверок: состояние приложения доступно только в тестах
  if (window.__HZ_TEST__) {
    const hook = window.__HZ_TEST__;
    Object.assign(hook, {
      init, loadAll, startSession, checkAnswer, nextQuestion, showHint, erasePad, finishSession, renderSessionCard, initPad,
      mediansOf(card) { return mediansFor(card); },
      submitAdd, parseListText, doImport, submitPhoto, exportJson, importJsonFile,
      buildIcs, saveSetting, scheduleNext, reasonAbout: reminderBody,
      debug: { db, tx, all, put },
      setPendingPhoto(v) { pendingPhoto = v; },
      setPadStrokes(s) { if (pad) { pad.strokes = s; drawPad(); } },
      get pad() { return pad; },
      get currentQuestion() { return currentQuestion; },
    });
    Object.defineProperties(hook, {
      cards: { get: () => cards, configurable: true },
      settings: { get: () => settings, configurable: true },
      session: { get: () => session, configurable: true },
      parsed: { get: () => parsed, configurable: true },
    });
  }

  document.addEventListener('DOMContentLoaded', init);
  // если app.js подключили после DOMContentLoaded — стартуем сразу
  if (document.readyState !== 'loading') setTimeout(init, 0);
})();
