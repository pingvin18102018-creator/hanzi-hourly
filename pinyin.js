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

  /* ==================== панель тонов ==================== */

  // Гласная без тона → четыре тоновых знака
  const VOWELS = {
    a: ['ā', 'á', 'ǎ', 'à'],
    e: ['ē', 'é', 'ě', 'è'],
    i: ['ī', 'í', 'ǐ', 'ì'],
    o: ['ō', 'ó', 'ǒ', 'ò'],
    u: ['ū', 'ú', 'ǔ', 'ù'],
    'ü': ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
    v: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
  };

  /** Тон на букву: «i» + 3 → «ǐ». Нейтральный (0) → буква без знака. */
  function accented(letter, tone) {
    const list = VOWELS[letter.toLowerCase()];
    if (!list || !tone) return letter;
    return list[tone - 1] || letter;
  }

  /** Какие знаки тонов бывает нужно поставить (для подписи кнопок). */
  const TONE_ROWS = [
    { base: 'a', tone: 1 }, { base: 'a', tone: 2 }, { base: 'a', tone: 3 }, { base: 'a', tone: 4 },
    { base: 'e', tone: 1 }, { base: 'e', tone: 2 }, { base: 'e', tone: 3 }, { base: 'e', tone: 4 },
    { base: 'i', tone: 1 }, { base: 'i', tone: 2 }, { base: 'i', tone: 3 }, { base: 'i', tone: 4 },
    { base: 'o', tone: 1 }, { base: 'o', tone: 2 }, { base: 'o', tone: 3 }, { base: 'o', tone: 4 },
    { base: 'u', tone: 1 }, { base: 'u', tone: 2 }, { base: 'u', tone: 3 }, { base: 'u', tone: 4 },
    { base: 'ü', tone: 1 }, { base: 'ü', tone: 2 }, { base: 'ü', tone: 3 }, { base: 'ü', tone: 4 },
  ];

  /** Убирает знаки тонов и цифры тонов: «nǐ hǎo» → «ni hao». */
  function stripTones(text) {
    const reverse = {};
    Object.keys(VOWELS).forEach((base) => {
      VOWELS[base].forEach((marked) => { reverse[marked] = base === 'v' ? 'ü' : base; });
    });
    return String(text == null ? '' : text)
      .replace(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/g, (ch) => reverse[ch] || ch)
      .replace(/[1-5]/g, '');
  }

  /**
   * Ставит тон на правильную гласную в тексте.
   * «ni» + 3 → «nǐ», «hao» + 3 → «hǎo», «liu» + 2 → «liú».
   * Если в поле несколько слогов («ni hao»), тон ставится в последний слог
   * без знака тона — так удобно набирать слово по частям.
   */
  function placeTone(text, tone, syllableIndex) {
    const raw = String(text == null ? '' : text);
    // делим на группы по пробелам/апострофам, сохраняя разделители
    const parts = raw.split(/([\s'’\-]+)/);
    const groups = [];
    parts.forEach((p, i) => { if (i % 2 === 0) groups.push({ index: i, text: p }); });

    const group = typeof syllableIndex === 'number'
      ? groups[syllableIndex]
      : groups[groups.length - 1];
    if (!group) return raw;

    // внутри группы найти слог, который будет получать тон
    const toneForVowel = (word) => {
      const letters = word.split('');
      const lower = word.toLowerCase();
      let pos = -1;
      if (lower.includes('a')) pos = lower.lastIndexOf('a');
      else if (lower.includes('e')) pos = lower.lastIndexOf('e');
      else if (lower.includes('iu')) pos = lower.lastIndexOf('u');
      else if (lower.includes('ou')) pos = lower.indexOf('o');
      else {
        for (let i = letters.length - 1; i >= 0; i -= 1) {
          if ('aeiouüv'.indexOf(letters[i].toLowerCase()) >= 0) { pos = i; break; }
        }
      }
      return pos;
    };

    const plainGroup = stripTones(group.text);
    // режем группу на слоги, чтобы понять, куда ставить знак
    const pieces = asSyllableList(plainGroup);
    let targetPiece = 0;
    for (let i = 0; i < pieces.length; i += 1) {
      const hasTone = parse(pieces[i]).some((s) => s.tone > 0);
      if (!hasTone) { targetPiece = i; break; }
      targetPiece = i;
    }

    // куда именно в этом слоге
    const word = pieces[targetPiece] || plainGroup;
    const pos = toneForVowel(word);
    if (pos < 0) return raw;

    let letters = word.split('');
    letters[pos] = accented(letters[pos], tone);
    let result = letters.join('');
    // сохраняем знаки тонов в остальных слогах группы
    const before = pieces.slice(0, targetPiece).map((pc) => {
      const t = parse(pc);
      return t.length && t[0].tone ? format([{ base: stripTones(pc), tone: t[0].tone }]) : pc;
    }).join('');
    const after = pieces.slice(targetPiece + 1).map((pc) => {
      const t = parse(pc);
      return t.length && t[0].tone ? format([{ base: stripTones(pc), tone: t[0].tone }]) : pc;
    }).join('');
    result = before + result + after;
    parts[group.index] = result;
    return parts.join('');
  }

  /** Сколько слогов в тексте (для подписей). */
  function syllableCount(text) {
    return parse(text).length;
  }

  /** 4 варианта с разными тонами: правильный + три перепутанных. */
  /** Разбивает пиньинь на слоги по пробелам и апострофам: «bái'éluósī» → 3 куска. */
  function splitSyllables(text) {
    return String(text == null ? '' : text).split(/([\s'’\-]+)/);
  }

  /** Знаки тонов — по ним понимаем, что слог уже получил тон. */
  const TONE_CHARS = 'āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ';
  const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's'];
  const VOWEL_CHARS = 'aeiouü';

  /** Первый слог строки без знаков тона: «women» → «wo». */
  function firstSyllable(s) {
    const lower = s.toLowerCase();
    const vi = lower.search(/[aeiouü]/);
    if (vi < 0) return s;
    // согласная после гласной закрывает слог, если за ней идёт гласная (men → слог «men»)
    for (let i = vi + 1; i < s.length; i += 1) {
      const ch = lower[i];
      if (VOWEL_CHARS.includes(ch)) continue;
      const next = lower[i + 1] || '';
      if (VOWEL_CHARS.includes(next)) return s.slice(0, i); // «men guo»
      // «ng»/«n» в конце — закрывают слог
      if ((ch === 'n' || ch === 'r') && !next) return s;
    }
    // гласных после — до следующей согласной+гласной
    for (let i = vi + 1; i < s.length; i += 1) {
      const ch = lower[i];
      if (!VOWEL_CHARS.includes(ch) && INITIALS.includes(ch) && VOWEL_CHARS.includes(lower[i + 2] || '')) {
        return s.slice(0, i);
      }
    }
    return s;
  }

  /**
   * Режет слово на слоги: «wǒmen» → [wǒ, men], «éluósī» → [é, luó, sī].
   * Слог заканчивается ПЕРЕД инициалом следующего слога.
   */
  function asSyllableList(text) {
    const out = [];
    splitSyllables(text).forEach((piece) => {
      let rest = piece.trim();
      if (!rest) return;
      let guard = 0;
      while (rest && guard < 12) {
        guard += 1;
        // слипшиеся знаки тона режем по гласной
        const chars = [...rest];
        let toneIdx = -1;
        chars.forEach((ch, i) => { if (TONE_CHARS.includes(ch)) toneIdx = i; });
        if (toneIdx < 0) { out.push(rest); return; }
        // от знака тона шагаем вперёд: если встретили инициал+гласную — это следующий слог
        let cut = rest.length;
        for (let i = toneIdx + 1; i < chars.length; i += 1) {
          const ch = chars[i].toLowerCase();
          if (VOWEL_CHARS.includes(ch)) continue;
          const two = (ch + (chars[i + 1] || '').toLowerCase());
          const three = (two + (chars[i + 2] || '').toLowerCase());
          const afterVowel = VOWEL_CHARS.includes(three[2] || '') || VOWEL_CHARS.includes(three[1] || '');
          if (INITIALS.includes(three) && VOWEL_CHARS.includes(chars[i + 3] || '').toString().length) { cut = i; break; }
          if ((afterVowel) && (INITIALS.includes(two) || INITIALS.includes(ch))) { cut = i; break; }
          if (i >= toneIdx + 1) { cut = rest.length; break; }
        }
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
    });
    return out;
  }
  function toneOptions(expected, count) {
    const n = count || 4;
    // Правильный вариант — ровно как в карточке (со всеми слогами и тонами).
    const right = String(expected == null ? '' : expected).trim();
    const pieces = asSyllableList(right);
    const options = [right];
    if (pieces.length === 0) return { right, options: [right] };

    // тон меняем только в одном слоге, остальные остаются как были
    pieces.forEach((piece, i) => {
      if (options.length >= n) return;
      const tone = (parse(piece)[0] || {}).tone || 0;
      for (let t = 1; t <= 4 && options.length < n; t += 1) {
        if (t === tone) continue;
        const variant = pieces
          .map((pc, idx) => (idx === i ? format([{ base: stripTones(pc), tone: t }]) : pc))
          .join(pieces.length > 1 && /[\s'’]/.test(right) ? '' : '');
        if (!options.includes(variant)) options.push(variant);
      }
    });
    while (options.length < n) options.push(`${stripTones(right)}`);
    return { right, options: shuffleTail(options) };
  }
  /** Перемешивает варианты, чтобы правильный не всегда был первым. */
  function shuffleTail(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  return {
    parse, format, compare, verdict, KNOWN,
    placeTone, stripTones, toneOptions, accented, TONE_ROWS, syllableCount,
  };
});
