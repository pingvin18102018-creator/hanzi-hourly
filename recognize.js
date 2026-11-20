/* 汉字 каждый час — проверка написанного от руки иероглифа.
 *
 * Сравниваем рисунок с эталонным начертанием (данные hanzi-writer из твоей
 * папки assets): сколько черт, где начинается и заканчивается каждая, куда идёт.
 *
 * Работает и в браузере (window.HanziCheck), и в node (require).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HanziCheck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Сравнение идёт в квадратной «коробке» 1000×1000: данные черт в этой системе.
  const SIZE = 1000;

  /* ---------- эталон: из medians (список точек по центру каждой черты) ---------- */
  function referenceFromMedians(medians) {
    return (medians || []).map((stroke) => {
      // hanzi-writer отдаёт medians в шкале 0..1 — приводим к 0..SIZE
      const big = stroke.some(([x, y]) => x > 2 || y > 2);
      const k = big ? 1 : SIZE;
      const pts = stroke.map(([x, y]) => ({ x: x * k, y: y * k }));
      return summarizeStroke(pts);
    });
  }

  /** Черта → длина, направление (угол), начало (доля) и конец. */
  function summarizeStroke(pts) {
    const start = pts[0];
    const end = pts[pts.length - 1];
    let len = 0;
    for (let i = 1; i < pts.length; i += 1) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return {
      start,
      end,
      mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
      len,
      angle: Math.atan2(end.y - start.y, end.x - start.x),
      points: pts,
    };
  }

  /* ---------- мой рисунок: штрихи пальца ---------- */
  /** Упрощает штрих (пиксели в коробке холста) → точки в системе 1000×1000. */
  function normalizeStroke(stroke, box) {
    const b = box || { x: 0, y: 0, size: 1 };
    const pts = [];
    stroke.forEach((p) => {
      const x = ((p.x - b.x) / b.size) * SIZE;
      const y = ((p.y - b.y) / b.size) * SIZE;
      const last = pts[pts.length - 1];
      if (last && Math.hypot(x - last.x, y - last.y) < SIZE * 0.012) return;
      pts.push({ x, y });
    });
    return pts.length > 1 ? pts : [];
  }

  /**
   * Полный рисунок → список черт для сравнения.
   * Короткие штрихи (палец может оставить «точку») тоже считаются:
   * лучше потом простить лишнюю короткую черту, чем потерять настоящую.
   */
  function prepareUser(strokes, box) {
    return (strokes || [])
      .map((s) => normalizeStroke(s, box))
      .filter((pts) => pts.length >= 1)
      .map(summarizeStroke);
  }

  /* ---------- сопоставление черт ---------- */
  // Живой почерк: форма и направление важнее, чем точное место начала черты.
  // Раньше «где начата/закончена» давало 50% оценки — правильно написанный
  // иероглиф со сдвигом на пару миллиметров считался ошибкой.
  const W = {
    start: 0.12,   // где начата черта (мягко)
    end: 0.12,     // где закончена (мягко)
    angle: 0.30,   // направление черты — главное (перевёрнутая черта = ошибка)
    shape: 0.16,   // близость по ходу черты
  };
  // Допустимый сдвиг всего иероглифа на холсте, в долях площадки.
  const SHIFT_TOLERANCE = 0.30;

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y) / SIZE;
  }

  function angleDiff(a, b) {
    let d = Math.abs(a - b) % (Math.PI * 2);
    if (d > Math.PI) d = Math.PI * 2 - d;
    return d / Math.PI; // 0..1
  }

  /** Среднее расстояние от точек одной черты до другой (по ходу). */
  function shapeDistance(a, b) {
    const sample = (pts, n) => {
      if (!pts || pts.length < 2) return [];
      const out = [];
      const step = (pts.length - 1) / (n - 1);
      for (let i = 0; i < n; i += 1) out.push(pts[Math.round(i * step)]);
      return out;
    };
    const pa = sample(a.points, 5);
    const pb = sample(b.points, 5);
    let sum = 0;
    for (let i = 0; i < pa.length; i += 1) sum += distance(pa[i], pb[i]);
    return sum / pa.length;
  }

  /** Стоимость сопоставления одной моей черты с одной эталонной (0 = идеально). */
  /** Насколько черта написана «не в ту сторону» (0 — правильно, 1 — наоборот). */
  function reverseScore(u, r) {
    // Угол ~180° значит, что черта написана от конца к началу.
    return angleDiff(u.angle, r.angle) > 0.5 ? 1 : 0;
  }

  function strokeCost(u, r) {
    return W.start * distance(u.start, r.start)
      + W.end * distance(u.end, r.end)
      + W.angle * angleDiff(u.angle, r.angle)
      + W.shape * shapeDistance(u, r);
  }

  /** Жадное сопоставление: самая дешёвая пара, затем следующая. */
  function match(user, ref) {
    const usedR = new Set();
    let reversed = 0;
    const total = user.reduce((acc, u) => {
      let best = Infinity;
      let bestI = -1;
      ref.forEach((r, i) => {
        if (usedR.has(i)) return;
        const c = strokeCost(u, r);
        if (c < best) { best = c; bestI = i; }
      });
      if (bestI >= 0) {
        usedR.add(bestI);
        if (reverseScore(u, ref[bestI])) reversed += 1;
      }
      return acc + (Number.isFinite(best) ? best : 1);
    }, 0);
    // Любая черта, написанная «наоборот», — ошибка, а не «немного похоже».
    return { cost: total / Math.max(1, user.length), reversed };
  }

  /**
   * Главная проверка.
   * strokes — штрихи пользователя в координатах холста;
   * box     — квадрат «площадки для письма» на холсте;
   * medians — эталонные черты (из assets/<иероглиф>.json).
   *
   * Сначала пробуем совместить весь рисунок с эталоном со сдвигом
   * (человек пишет не точно по центру). Берём лучший из вариантов.
   */
  function compare(strokes, box, medians, options) {
    const opts = options || {};
    const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.38;
    const ref = referenceFromMedians(medians);
    const raw = prepareUser(strokes, box);
    if (!ref.length || !raw.length) {
      return {
        ok: false,
        score: 1,
        threshold,
        userCount: raw.length,
        refCount: ref.length,
        missing: Math.max(0, ref.length - raw.length),
        extra: Math.max(0, raw.length - ref.length),
        reference: null,
        expected: ref,
        shift: { x: 0, y: 0 },
      };
    }

    // Пробуем сдвинуть рисунок в пределах SHIFT_TOLERANCE и выбрать лучшее совпадение.
    const shiftPx = SIZE * SHIFT_TOLERANCE;
    const best = { score: Infinity, reversed: 0, shift: { x: 0, y: 0 }, user: raw };
    const steps = [-1, -0.6, -0.3, 0, 0.3, 0.6, 1];
    steps.forEach((sx) => {
      steps.forEach((sy) => {
        const dx = sx * shiftPx;
        const dy = sy * shiftPx;
        const moved = raw.map((u) => ({
          ...u,
          start: { x: u.start.x + dx, y: u.start.y + dy },
          end: { x: u.end.x + dx, y: u.end.y + dy },
          points: u.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
        }));
        const m = match(moved, ref);
        // лучшее совпадение = меньше всего перевёрнутых черт, затем меньше стоимость
        const better = m.cost < best.score
          || (Math.abs(m.cost - best.score) < 0.02 && m.reversed < best.reversed);
        if (better) {
          best.score = m.cost;
          best.reversed = m.reversed;
          best.shift = { x: dx, y: dy };
          best.user = moved;
        }
      });
    });

    // штраф за неверное число черт
    const countPenalty = raw.length === ref.length
      ? 0
      : Math.min(0.35, Math.abs(raw.length - ref.length) * 0.16);
    const shiftRatio = Math.hypot(best.shift.x, best.shift.y) / (SIZE * SHIFT_TOLERANCE);
    const shiftPenalty = Math.min(0.20, Math.max(0, shiftRatio - 0.6) * 0.3);
    // перевёрнутая черта — не «немного неточно», а ошибка
    const reversePenalty = Math.min(1, best.reversed * 0.5);
    const score = Math.min(1, best.score + countPenalty + shiftPenalty + reversePenalty);
    // Порог зависит от того, насколько рисунок «похож по масштабу»:
    // каракули короткими штрихами не должны проскакивать.
    const refLen = ref.reduce((a, r) => a + r.len, 0);
    const userLen = raw.reduce((a, u) => a + u.len, 0);
    const lenRatio = refLen > 0 ? userLen / refLen : 0;
    // если общая длина черт сильно меньше эталона — это не иероглиф
    const lenOk = lenRatio > 0.55 && lenRatio < 1.8;
    // битая ссылка на массив перевёрнутых — считаем, что данных нет
    const reversedCount = typeof best.reversed === 'number' ? best.reversed : 0;
    const ok = lenOk && reversedCount === 0 && raw.length === ref.length && score <= threshold;

    return {
      ok,
      score,
      threshold,
      userCount: raw.length,
      refCount: ref.length,
      missing: Math.max(0, ref.length - raw.length),
      extra: Math.max(0, raw.length - ref.length),
      reference: opts.withReference === false ? null : raw,
      expected: ref,
      shift: best.shift,
    };
  }

  /** Подпись под результатом — только текст, без звука. */
  function verdict(res) {
    if (!res.userCount) return { ok: false, text: 'Сначала нарисуй иероглиф' };
    if (res.ok) return { ok: true, text: '✅ Правильно' };
    if (res.userCount < res.refCount) {
      return { ok: false, text: `❌ Не хватает черт: ${res.refCount} нужно, у тебя ${res.userCount}` };
    }
    if (res.userCount > res.refCount) {
      return { ok: false, text: `❌ Лишние черты: ${res.refCount} нужно, у тебя ${res.userCount}` };
    }
    return { ok: false, text: '❌ Непохоже на иероглиф — посмотри подсказку' };
  }

  return {
    SIZE, referenceFromMedians, prepareUser, compare, verdict, strokeCost, shapeDistance,
  };
});
