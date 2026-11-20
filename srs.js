/* 汉字 каждый час — расчёт повторений (SRS).
 *
 * «Знаю» ведёт слово по ступеням 0→5:
 *   0 (только добавлено) → 1 ч → 3 ч → 1 день → 3 дня → 7 дней → 21 день
 * «Не помню» сбрасывает на ступень 0: слово вернётся в ближайшую сессию.
 *
 * Один и тот же файл работает и в браузере (window.SRS), и в node (require).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SRS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  // Интервалы для каждой ступени: сколько ждать после верного ответа.
  // Первая ступень — час: тренировка каждые 60 минут, поэтому слово,
  // выученное в этой тренировке, ждёт следующей.
  const STAGES = [
    { stage: 0, after: 1 * HOUR, label: '1 час' },
    { stage: 1, after: 3 * HOUR, label: '3 часа' },
    { stage: 2, after: 1 * DAY, label: '1 день' },
    { stage: 3, after: 3 * DAY, label: '3 дня' },
    { stage: 4, after: 7 * DAY, label: '7 дней' },
    { stage: 5, after: 21 * DAY, label: '21 день' },
  ];
  const MAX_STAGE = STAGES.length - 1;
  // Слово с ошибкой возвращается в следующей тренировке (не раньше 30 минут).
  const LAPSE_MIN_GAP = 30 * 60 * 1000;
  // Вопросы к слову — как в твоих карточках: по пиньиню, по иероглифу, по переводу.
  // Пиньинь проверяется двумя способами: панель тонов и выбор из 4 вариантов.
  const QUESTION_TYPES = [
    { id: 'pinyin_to_hanzi', label: 'по пиньиню → иероглиф' },
    { id: 'pinyin_panel', label: 'пишу пиньинь, тон — кнопкой' },
    { id: 'pinyin_choice', label: 'какой пиньинь правильный' },
    { id: 'meaning_to_hanzi', label: 'по переводу → иероглиф' },
  ];

  function clampStage(stage) {
    const n = Number.isFinite(stage) ? Math.floor(stage) : 0;
    return Math.min(MAX_STAGE, Math.max(0, n));
  }

  /**
   * Какой будет ступень и когда показать слово снова.
   * stage — ступень ДО ответа; после верного ответа она растёт на единицу.
   */
  function next(stage, known, now) {
    const t = Number.isFinite(now) ? now : Date.now();
    if (known) {
      const s = clampStage(clampStage(stage) + 1);
      return { stage: s, due: t + STAGES[s].after, interval: STAGES[s].after };
    }
    return { stage: 0, due: t + LAPSE_MIN_GAP, interval: LAPSE_MIN_GAP };
  }

  /**
   * Какой вопрос задать: тип выбирается случайно, но слабый тип (где больше
   * ошибок) выпадает чаще. prev — тип предыдущего вопроса, чтобы не повторить.
   */
  function pickQuestionType(card, rnd, prev) {
    const r = typeof rnd === 'function' ? rnd : Math.random;
    const stats = (card && card.q) || {};
    const weights = QUESTION_TYPES.map((t) => {
      const s = stats[t.id];
      const wrong = s ? s.wrong : 0;
      const right = s ? s.right : 0;
      // ещё не спрашивали → обычный шанс; много ошибок → до ×3
      const base = right + wrong === 0 ? 1.2 : 1;
      const weight = base * (1 + wrong * 0.6);
      return { id: t.id, weight };
    }).filter((w) => w.id !== prev || QUESTION_TYPES.length === 1);
    const total = weights.reduce((a, w) => a + w.weight, 0);
    let roll = r() * total;
    for (const w of weights) {
      roll -= w.weight;
      if (roll <= 0) return w.id;
    }
    return weights[weights.length - 1].id;
  }

  /** Что показать в вопросе (и что спрятать) для каждого типа. */
  function questionFor(card, type) {
    // панель тонов: пишешь буквы, тон ставишь кнопкой
    if (type === 'pinyin_panel') {
      return { prompt: card.hanzi, ask: 'напиши пиньинь — тон поставь кнопкой', kind: 'pinyin_panel' };
    }
    // выбор из 4: какой пиньинь правильный
    if (type === 'pinyin_choice') {
      return { prompt: card.hanzi, ask: 'какой пиньинь правильный?', kind: 'pinyin_choice' };
    }
    if (type === 'hanzi_to_pinyin') return { prompt: card.hanzi, ask: 'напиши пиньинь', kind: 'pinyin' };
    if (type === 'pinyin_to_hanzi') return { prompt: card.pinyin || card.hanzi, ask: 'напиши иероглиф', kind: 'hanzi' };
    return { prompt: card.meaning || card.hanzi, ask: 'напиши иероглиф', kind: 'hanzi' };
  }

  /**
   * Какой способ проверки пиньиня использовать.
   * mode: 'panel' — только панель тонов; 'choice' — только 4 варианта; 'both' — как повезёт.
   */
  function pinyinTypeFor(mode, rnd) {
    const r = typeof rnd === 'function' ? rnd : Math.random;
    if (mode === 'panel') return 'pinyin_panel';
    if (mode === 'choice') return 'pinyin_choice';
    return r() < 0.5 ? 'pinyin_panel' : 'pinyin_choice';
  }

  /** Сколько вопросов в тренировке: ровно limit, но не больше, чем слов. */
  function sessionSize(cards, limit) {
    const live = (cards || []).filter((c) => c && !c.archived);
    const words = new Set(live.map((c) => c.hanzi)).size;
    return Math.max(1, Math.min(Number(limit) || 10, words));
  }

  /** Ждёт ли слово повторения прямо сейчас. */
  function isDue(card, now) {
    const t = Number.isFinite(now) ? now : Date.now();
    if (!card || card.archived) return false;
    return (card.due || 0) <= t;
  }

  /**
   * Карточки для тренировки: сначала самые «просроченные».
   * Если готовых к повторению мало (например, всё выучено) — берём ближайшие
   * по времени, чтобы сессия никогда не была пустой, но не больше limit.
   */
  function pickSession(cards, limit, now, filter) {
    const t = Number.isFinite(now) ? now : Date.now();
    const n = Math.max(1, Number(limit) || 5);
    const pool = (cards || [])
      .filter((c) => c && !c.archived)
      .filter((c) => (typeof filter === 'function' ? filter(c) : true));
    const due = pool.filter((c) => (c.due || 0) <= t).sort((a, b) => (a.due || 0) - (b.due || 0));
    if (due.length >= n) return due.slice(0, n);
    const upcoming = pool
      .filter((c) => (c.due || 0) > t)
      .sort((a, b) => (a.due || 0) - (b.due || 0));
    return due.concat(upcoming).slice(0, n);
  }

  /** Сколько карточек ждут повторения. */
  function dueCount(cards, now) {
    const t = Number.isFinite(now) ? now : Date.now();
    return (cards || []).filter((c) => c && !c.archived && (c.due || 0) <= t).length;
  }

  /** Человеческое описание, когда будет следующее повторение. */
  function describeDue(due, now) {
    const t = Number.isFinite(now) ? now : Date.now();
    const ms = (due || 0) - t;
    if (ms <= 0) return 'сейчас';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `через ${mins} мин`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `через ${hours} ч`;
    const days = Math.round(hours / 24);
    return `через ${days} дн`;
  }

  // Разбор вставленного списка слов. Поддерживаем:
  //   你 | nǐ | ты
  //   你	nǐ	ты
  //   你, nǐ, ты
  //   你 nǐ ты              (пробелы — если в строке есть 汉字)
  //   你 - nǐ - ты
  //   # комментарий, пустые строки — пропускаются
  const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

  function parseList(text) {
    const rows = [];
    const bad = [];
    const lines = String(text || '').split(/\r?\n/);
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      let parts = null;
      if (line.includes('|')) parts = line.split('|');
      else if (line.includes('\t')) parts = line.split('\t');
      else if (/(^|\s)[—–-](\s|$)/.test(line)) parts = line.split(/\s+[—–-]\s+/);
      else if ((line.match(/,/g) || []).length >= 2) parts = line.split(',');
      else if (CJK.test(line)) {
        // «你 nǐ ты» / «你好 nǐ hǎo привет»: 汉字, затем латиница, затем остальное
        const m = line.match(/^(\S*[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]\S*)\s+([A-Za-züÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ·0-9]+)\s+(.+)$/);
        if (m) parts = [m[1], m[2], m[3]];
      }
      if (!parts) {
        bad.push({ line: i + 1, text: line });
        return;
      }
      const clean = parts.map((p) => p.trim()).filter(Boolean);
      const hanzi = clean.find((p) => CJK.test(p));
      const pinyin = clean.find((p) => /[A-Za-z]/.test(p) && !CJK.test(p));
      const meaning = clean.find((p) => p !== hanzi && p !== pinyin);
      if (!hanzi) {
        bad.push({ line: i + 1, text: line });
        return;
      }
      rows.push({
        hanzi,
        pinyin: pinyin || '',
        meaning: meaning || '',
        example_zh: '',
        example_ru: '',
        note: '',
      });
    });
    return { rows, bad };
  }

  /** Нормализация слова для поиска дублей. */
  function keyOf(card) {
    return `${(card.hanzi || '').trim().toLowerCase()}|${(card.pinyin || '').trim().toLowerCase()}`;
  }

  return {
    HOUR, DAY, STAGES, MAX_STAGE, LAPSE_MIN_GAP, QUESTION_TYPES,
    next, isDue, pickSession, dueCount, describeDue, parseList, keyOf,
    pickQuestionType, questionFor, sessionSize, pinyinTypeFor,
  };
});
