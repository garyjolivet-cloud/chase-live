
// KHDataAnalyzer.test.js
// Tests T1–T5 (overnightSnow) and W1–W4 (recentWind) from SPEC v0.6 § 4.1, 4.2

import { KHDataAnalyzer } from '../src/KHDataAnalyzer.js';

// ─── Helpers ────────────────────────────────────────────────────────────

// Build a Dogtooth history row.
// values column layout: [airTemp, rh, hn24, hst, hs, hrPrecip, cumPrecip, dir, wind, gust]
function dogtoothRow(timeLabel, airTemp, hrPrecip) {
  return {
    timeLabel,
    values: [airTemp, null, null, null, null, hrPrecip, null, null, null, null],
  };
}

// Build a White Wall history row.
// values column layout: [airTemp, dir, wind, gust]
function whiteWallRow(timeLabel, dir, wind, gust = null) {
  return {
    timeLabel,
    values: [null, dir, wind, gust ?? wind],
  };
}

// Format a Date as KH timeLabel "MM-DD HH:MM"
function khLabel(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mn = String(date.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mn}`;
}

// Build an API response fixture with the given fetchedAt and history rows.
function mockApi({ fetchedAt, dogtoothHistory = [], whiteWallHistory = [], whiteWall = null, dogtooth = null }) {
  return {
    ok: true,
    fetchedAt: fetchedAt.toISOString(),
    dogtooth,
    whiteWall,
    dogtoothHistory,
    whiteWallHistory,
  };
}

// Generate one hourly row from start to end at given temp/precip
function hoursBetween(startDate, endDate, fn) {
  const rows = [];
  const cur = new Date(startDate);
  while (cur.getTime() <= endDate.getTime()) {
    rows.push(fn(new Date(cur)));
    cur.setHours(cur.getHours() + 1);
  }
  return rows;
}

// ─── T1: Empty history ──────────────────────────────────────────────────
test('T1 — overnightSnow: empty history returns zeros', () => {
  const fetchedAt = new Date(2026, 0, 15, 10, 0); // 10 AM
  const api = mockApi({ fetchedAt });
  const a = new KHDataAnalyzer(api);
  const r = a.overnightSnow();

  assertEq(r.swe_mm, 0, 'T1 swe_mm');
  assertEq(r.snow_cm, 0, 'T1 snow_cm');
  assertEq(r.source, 'no data in window', 'T1 source');
});

// ─── T2: Hourly precip 4 PM → 8 AM @ -8°C tested at 10 AM (finalized) ──
test('T2 — overnightSnow: cold powder, finalized after 9 AM', () => {
  // Tested at 10 AM on Jan 15.
  // Window: yesterday 4 PM → today 9 AM (frozen because we're past 9 AM).
  // Inject precipitation rows at -8°C every hour from yesterday 4 PM to today 8 AM.
  const fetchedAt = new Date(2026, 0, 15, 10, 0); // Jan 15, 10:00
  const windowStart = new Date(2026, 0, 14, 16, 0); // yesterday 4 PM
  const windowEnd   = new Date(2026, 0, 15, 8, 0);  // today 8 AM (inside window)

  // 17 hours, each with 0.3mm precip at -8°C → 17 × 0.3 = 5.1 mm SWE
  const dogtoothHistory = hoursBetween(windowStart, windowEnd, (t) =>
    dogtoothRow(khLabel(t), -8, 0.3)
  );

  const api = mockApi({ fetchedAt, dogtoothHistory });
  const a = new KHDataAnalyzer(api);
  const r = a.overnightSnow();

  assertClose(r.swe_mm, 5.1, 0.1, 'T2 swe_mm');
  assertEq(r.ratio, 13, 'T2 ratio (cold powder @ -8°C)');
  assertClose(r.snow_cm, (5.1 * 13) / 10, 0.2, 'T2 snow_cm');
  assertEq(r.windowState, 'finalized', 'T2 windowState after 9 AM');
  assertEq(r.isRain, false, 'T2 not rain');
});

// ─── T3: Same data tested at 7 AM → in_progress ─────────────────────────
test('T3 — overnightSnow: same data tested before 9 AM → in_progress', () => {
  const fetchedAt = new Date(2026, 0, 15, 7, 0); // Jan 15, 7 AM
  const windowStart = new Date(2026, 0, 14, 16, 0);

  // Hours up to 6 AM (before fetchedAt of 7 AM)
  const cutoff = new Date(2026, 0, 15, 6, 0);
  const dogtoothHistory = hoursBetween(windowStart, cutoff, (t) =>
    dogtoothRow(khLabel(t), -8, 0.3)
  );

  const api = mockApi({ fetchedAt, dogtoothHistory });
  const a = new KHDataAnalyzer(api);
  const r = a.overnightSnow();

  assertEq(r.windowState, 'in_progress', 'T3 windowState before 9 AM');
  // Window ends at "now" (7 AM), so we should have fewer hours than T2's full window
  assert(r.hours > 0, 'T3 should have some hours');
  assert(r.swe_mm > 0, 'T3 should have swe accumulation');
});

// ─── T4: All temps > +2°C, precip → rain ────────────────────────────────
test('T4 — overnightSnow: warm temps → isRain true, snow_cm = 0', () => {
  const fetchedAt = new Date(2026, 0, 15, 10, 0);
  const windowStart = new Date(2026, 0, 14, 16, 0);
  const windowEnd = new Date(2026, 0, 15, 8, 0);

  // Hourly rows at +3°C with 0.3mm precip
  const dogtoothHistory = hoursBetween(windowStart, windowEnd, (t) =>
    dogtoothRow(khLabel(t), 3, 0.3)
  );

  const api = mockApi({ fetchedAt, dogtoothHistory });
  const a = new KHDataAnalyzer(api);
  const r = a.overnightSnow();

  assertEq(r.isRain, true, 'T4 isRain');
  assertEq(r.snow_cm, 0, 'T4 snow_cm = 0 because rain');
  assertEq(r.ratio, 0, 'T4 ratio = 0 (rain)');
  assert(r.swe_mm > 0, 'T4 still records swe_mm (water fell)');
});

// ─── T5: History includes hours outside window → excluded ───────────────
test('T5 — overnightSnow: out-of-window hours excluded', () => {
  const fetchedAt = new Date(2026, 0, 15, 10, 0);

  // Build a mix: 2 PM yesterday (BEFORE window), 4 PM-8 AM (IN window), 11 AM today (AFTER window/finalized at 9 AM)
  const inWindowStart = new Date(2026, 0, 14, 16, 0);
  const inWindowEnd = new Date(2026, 0, 15, 8, 0);

  const dogtoothHistory = [
    // Outside (before window) — should be excluded
    dogtoothRow(khLabel(new Date(2026, 0, 14, 14, 0)), -8, 99),
    // Inside window — should be included (17 hours × 0.3 = 5.1mm)
    ...hoursBetween(inWindowStart, inWindowEnd, (t) =>
      dogtoothRow(khLabel(t), -8, 0.3)
    ),
    // Outside (after window cutoff of 9 AM) — should be excluded
    dogtoothRow(khLabel(new Date(2026, 0, 15, 11, 0)), -8, 99),
  ];

  const api = mockApi({ fetchedAt, dogtoothHistory });
  const a = new KHDataAnalyzer(api);
  const r = a.overnightSnow();

  // If outside rows were included, swe_mm would be ~5.1 + 99 + 99 = ~203
  // If excluded correctly, swe_mm ≈ 5.1
  assertClose(r.swe_mm, 5.1, 0.5, 'T5 only in-window rows summed');
});

// ─── W1: Empty history → snapshot fallback ──────────────────────────────
test('W1 — recentWind: empty history uses snapshot fallback', () => {
  const fetchedAt = new Date(2026, 0, 15, 10, 0);
  const api = mockApi({
    fetchedAt,
    whiteWall: { wind: 25, dir: 270, gust: 40 },
  });
  const a = new KHDataAnalyzer(api);
  const r = a.recentWind();

  assertEq(r.source, 'snapshot fallback', 'W1 source');
  assertEq(r.avgKph, 25, 'W1 avgKph from snapshot');
  assertEq(r.dominantDir, 270, 'W1 dominantDir from snapshot');
  assertEq(r.sampleCount, 0, 'W1 no samples');
});

// ─── W2: Steady 10 kph @ 270° ───────────────────────────────────────────
test('W2 — recentWind: steady wind averages cleanly', () => {
  const fetchedAt = new Date(2026, 0, 15, 10, 0);
  const start = new Date(2026, 0, 14, 22, 0); // 12 hours back
  const whiteWallHistory = hoursBetween(start, fetchedAt, (t) =>
    whiteWallRow(khLabel(t), 270, 10)
  );

  const api = mockApi({ fetchedAt, whiteWallHistory });
  const a = new KHDataAnalyzer(api);
  const r = a.recentWind(12);

  assertEq(r.avgKph, 10, 'W2 avgKph');
  assertClose(r.dominantDir, 270, 5, 'W2 dominantDir');
});

// ─── W3: 359° and 1° equal speeds → near 0°, NOT 180° ───────────────────
test('W3 — recentWind: 359° + 1° averages to ~0°, not 180°', () => {
  const fetchedAt = new Date(2026, 0, 15, 10, 0);
  const t1 = new Date(2026, 0, 15, 9, 0);
  const t2 = new Date(2026, 0, 15, 8, 0);
  const t3 = new Date(2026, 0, 15, 7, 0);
  const t4 = new Date(2026, 0, 15, 6, 0);

  const whiteWallHistory = [
    whiteWallRow(khLabel(t1), 359, 10),
    whiteWallRow(khLabel(t2), 1, 10),
    whiteWallRow(khLabel(t3), 359, 10),
    whiteWallRow(khLabel(t4), 1, 10),
  ];

  const api = mockApi({ fetchedAt, whiteWallHistory });
  const a = new KHDataAnalyzer(api);
  const r = a.recentWind(12);

  // Vector mean should land near 0° (or 360°), NOT 180°
  const d = r.dominantDir;
  const nearZero = (d < 10 || d > 350);
  assert(nearZero, `W3 dominantDir near 0/360, got ${d}`);
});

// ─── W4: One strong-wind hour dominates direction (weighted by speed) ───
test('W4 — recentWind: vector mean weights by wind speed', () => {
  const fetchedAt = new Date(2026, 0, 15, 10, 0);

  const whiteWallHistory = [
    // 1 hour of strong wind from 280°
    whiteWallRow(khLabel(new Date(2026, 0, 15, 9, 0)), 280, 50),
    // 3 hours of light wind from 90°
    whiteWallRow(khLabel(new Date(2026, 0, 15, 8, 0)), 90, 5),
    whiteWallRow(khLabel(new Date(2026, 0, 15, 7, 0)), 90, 5),
    whiteWallRow(khLabel(new Date(2026, 0, 15, 6, 0)), 90, 5),
  ];

  const api = mockApi({ fetchedAt, whiteWallHistory });
  const a = new KHDataAnalyzer(api);
  const r = a.recentWind(12);

  // Vector mean weighted by speed: 50 kph @ 280° vs 15 kph @ 90°.
  // 280° dominates. Expect dominantDir in the 240–320° range.
  const d = r.dominantDir;
  const weightedWest = d > 240 && d < 320;
  assert(weightedWest, `W4 dominantDir weighted toward 280°, got ${d}`);
});
