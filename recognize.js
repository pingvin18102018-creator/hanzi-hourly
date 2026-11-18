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

  /** Полный рисунок → список черт для сравнения. */
  function prepareUser(strokes, box) {
    return (strokes || [])
      .map((s) => normalizeStroke(s, box))
      .filter((pts) => pts.length > 1)
      .map(summarizeStroke);
  }

  /* ---------- сопоставление черт ---------- */
  const W = {
    count: 0.30,   // число черт важнее всего
    start: 0.26,   // где начата черта (порядок и место)
    end: 0.24,     // где закончена
    angle: 0.16,   // направление
    shape: 0.10,   // близость по ходу черты (мягко: у живого письма кривизна)
  };

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
  function strokeCost(u, r) {
    return W.start * distance(u.start, r.start)
      + W.end * distance(u.end, r.end)
      + W.angle * angleDiff(u.angle, r.angle)
      + W.shape * shapeDistance(u, r);
  }

  /** Жадное сопоставление: самая дешёвая пара, затем следующая. */
  function match(user, ref) {
    const usedR = new Set();
    const total = user.reduce((acc, u) => {
      let best = Infinity;
      let bestI = -1;
      ref.forEach((r, i) => {
        if (usedR.has(i)) return;
        const c = strokeCost(u, r);
        if (c < best) { best = c; bestI = i; }
      });
      if (bestI >= 0) usedR.add(bestI);
      return acc + (Number.isFinite(best) ? best : 1);
    }, 0);
    return total / Math.max(1, user.length);
  }

  /**
   * Главная проверка.
   * strokes — штрихи пользователя в координатах холста;
   * box     — квадрат «площадки для письма» на холсте;
   * medians — эталонные черты (из assets/<иероглиф>.json).
   *
   * Возвращает { ok, score, missing, extra, reference, user } — reference и user
   * нужны, чтобы нарисовать подсказку «где ошибка».
   */
  function compare(strokes, box, medians, options) {
    const opts = options || {};
    const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.24;
    const ref = referenceFromMedians(medians);
    const user = prepareUser(strokes, box);
    let score = 1;
    let countPenalty = 0;
    if (ref.length && user.length) {
      if (user.length !== ref.length) countPenalty = Math.min(0.35, Math.abs(user.length - ref.length) * 0.16);
      score = Math.min(1, match(user, ref) + countPenalty);
    }
    const ok = ref.length > 0 && user.length > 0 && user.length === ref.length && score <= threshold;
    return {
      ok,
      score,
      threshold,
      userCount: user.length,
      refCount: ref.length,
      missing: Math.max(0, ref.length - user.length),
      extra: Math.max(0, user.length - ref.length),
      reference: opts.withReference === false ? null : user,
      expected: ref,
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
