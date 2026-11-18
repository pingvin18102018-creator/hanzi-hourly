/* 汉字 каждый час — проверка пиньиня.
 *
 * Сравниваем по смыслу: «nǐ» и «ni» — оба верны. Если тон указан
 * и неверный — говорим «верно, но тон другой».
 *
 * Работает и в браузере (window.PinyinCheck), и в node (require).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PinyinCheck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Буква с тоном → (простая буква, номер тона)
  const TONE_MAP = {
    'ā': [0, 1], 'á': [0, 2], 'ǎ': [0, 3], 'à': [0, 4],
    'ē': [1, 1], 'é': [1, 2], 'ě': [1, 3], 'è': [1, 4],
    'ī': [2, 1], 'í': [2, 2], 'ǐ': [2, 3], 'ì': [2, 4],
    'ō': [3, 1], 'ó': [3, 2], 'ǒ': [3, 3], 'ò': [3, 4],
    'ū': [4, 1], 'ú': [4, 2], 'ǔ': [4, 3], 'ù': [4, 4],
    'ǖ': [5, 1], 'ǘ': [5, 2], 'ǚ': [5, 3], 'ǜ': [5, 4],
  };
  const PLAIN = ['a', 'e', 'i', 'o', 'u', 'ü'];
  const KNOWN = new Set(['n', 'ng', 'm', 'r', 'er', 'hm', 'hng']);

  /** «zhǎng» → [{ base:'zhang', tone:3 }] */
  function parse(text) {
    const s = String(text == null ? '' : text).toLowerCase().trim();
    const syllables = [];
    let cur = '';
    let curTone = 0;
    const flush = () => {
      if (cur) { syllables.push({ base: cur, tone: curTone }); cur = ''; curTone = 0; }
    };
    for (const ch of s) {
      if (TONE_MAP[ch]) {
        const [idx, tone] = TONE_MAP[ch];
        cur += PLAIN[idx];
        curTone = tone;
      } else if (/[a-zü]/.test(ch)) {
        cur += ch;
      } else if (/[0-9]/.test(ch)) {
        // «ni3» — цифра после слога
        if (cur) { curTone = curTone || Number(ch); flush(); }
      } else {
        // пробел, апостроф, дефис и знаки препинания делят слоги
        flush();
      }
    }
    flush();
    return syllables;
  }

  /** «ni» → «nǐ»: восстанавливаем тон из эталона для подсказки. */
  function format(syllables) {
    return syllables.map((s) => {
      const letters = s.base.split('');
      const idx = toneVowel(letters);
      if (s.tone && idx >= 0) {
        const v = letters[idx];
        const vi = PLAIN.indexOf(v === 'v' ? 'ü' : v);
        if (vi >= 0) letters[idx] = Object.keys(TONE_MAP).find((k) => {
          const [i, t] = TONE_MAP[k];
          return i === vi && t === s.tone;
        }) || v;
      }
      return letters.join('');
    }).join('');
  }

  /** Куда ставится знак тона: a/e главнее, в «ou» — на o, в «iu» — на u. */
  function toneVowel(letters) {
    const has = (c) => letters.indexOf(c);
    if (has('a') >= 0) return has('a');
    if (has('e') >= 0) return has('e');
    if (letters.join('').includes('ou')) return has('o');
    return letters.length - 1;
  }

  /** «ni», «nv» или «nü» → одна форма для сравнения. */
  function sameBase(a, b) {
    const fix = (t) => t.replace(/v/g, 'ü');
    return fix(a) === fix(b);
  }

  /** Совпадают ли слоги целиком (nǐ = ni = nv = nü; wǒmen = wo men). */
  function sameText(a, b) {
    const fix = (t) => t.replace(/v/g, 'ü').replace(/\s+/g, '');
    return fix(a) === fix(b);
  }

  /**
   * Результат:
   *   'correct'  — всё совпало (тоны либо не указаны, либо верные)
   *   'tone'     — буквы верные, а тон не тот
   *   'wrong'    — остальное
   *   'empty'    — ничего не написано
   */
  function compare(answer, expected) {
    const a = parse(answer);
    const e = parse(expected);
    if (!a.length) return { result: 'empty', expected: format(e), clean: false };
    if (!e.length) return { result: 'tone', expected: String(expected), clean: false };

    const aText = a.map((x) => x.base).join('');
    const eText = e.map((x) => x.base).join('');
    const sameCount = a.length === e.length;

    const lettersOk = sameCount
      ? a.every((x, i) => sameBase(x.base, e[i].base))
      : sameBase(aText, eText) || sameText(answer, expected);
    if (!lettersOk) return { result: 'wrong', expected: format(e), clean: false };

    const anyTone = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]|[1-5]/.test(String(answer || ''));
    // Тоны сверяем, только когда эталон их содержит и слоги разделены так же.
    const expectedHasTones = e.some((x) => x.tone > 0);
    if (!anyTone || !sameCount || !expectedHasTones) {
      return { result: 'correct', toneMissed: !anyTone, expected: format(e), clean: false };
    }

    const tonesOk = a.every((x, i) => !x.tone || x.tone === e[i].tone);
    if (!tonesOk) return { result: 'tone', expected: format(e), clean: false };
    const full = a.every((x, i) => x.tone && x.tone === e[i].tone);
    return { result: 'correct', expected: format(e), clean: full };
  }

  /** «ni3 men」 → «30»: тоны, указанные цифрой. */
  function toneDigits(text) {
    const s = String(text || '').toLowerCase();
    const digits = s.match(/[1-5]/g);
    return digits ? digits.join('') : '';
  }

  /** Короткая подсказка для экрана. */
  function verdict(res) {
    if (res.result === 'correct') return { ok: true, text: res.clean ? '✅ Правильно' : '✅ Правильно (тон можно не писать)' };
    if (res.result === 'tone') return { ok: false, text: '❌ Буквы верные, но тон другой' };
    if (res.result === 'empty') return { ok: false, text: 'Сначала напиши ответ' };
    return { ok: false, text: '❌ Неверно' };
  }

  return { parse, format, compare, verdict, KNOWN };
});
