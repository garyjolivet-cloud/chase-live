// KHDataAnalyzer.js — analysis module for KH weather station data
// ─────────────────────────────────────────────────────────────
// Derives meaningful values (overnight snow, recent wind, etc.)
// from the raw KH page-scraper JSON. Pure JavaScript: no DOM,
// no HTTP, no mutation of input.
//
// Conforms to SPEC v0.7 § 3.2.
// Tests: tests/KHDataAnalyzer.test.js (T1-T5, W1-W4).

// ─── Constants ──────────────────────────────────────────────

// Overnight window definition.
// Window opens at OVERNIGHT_START_HOUR (yesterday) and closes at
// OVERNIGHT_FREEZE_HOUR (today). Before freeze hour, window is "in_progress"
// and uses "now" as the upper bound.
const OVERNIGHT_START_HOUR = 16;  // 4 PM (yesterday)
const OVERNIGHT_FREEZE_HOUR = 9;  // 9 AM (today, when window finalizes)

// Snow:water ratio table by mean overnight temperature (°C).
// Colder → drier snow → higher ratio.
// Warmer → wetter snow → lower ratio.
// Above RAIN_TEMP_C → rain, no snow.
const RAIN_TEMP_C = 1.0;  // if mean temp > +1°C, treat precip as rain

function snowWaterRatio(meanTempC) {
  // Spec ratio table: cold dry 22:1 → warm wet 8:1.
  // Boundaries calibrated so -8°C → 13 (per test T2).
  if (meanTempC < -20) return 22;
  if (meanTempC < -15) return 18;
  if (meanTempC < -10) return 15;
  if (meanTempC < -5)  return 13;
  if (meanTempC < 0)   return 11;
  if (meanTempC <= RAIN_TEMP_C) return 8;
  return 0;  // rain, no snow
}

// Dogtooth row column layout (SPEC §3.1).
// values: [airTemp, rh, hn24, hst, hs, hrPrecip, cumPrecip, dir, wind, gust]
const D_TEMP    = 0;
const D_PRECIP  = 5;

// White Wall row column layout.
// values: [airTemp, dir, wind, gust]
const W_TEMP = 0;
const W_DIR  = 1;
const W_WIND = 2;
const W_GUST = 3;

// ─── Helpers ────────────────────────────────────────────────

// Parse a KH timeLabel "MM-DD HH:MM" into a Date relative to a reference year.
// (The KH page doesn't include the year; we infer it from the reference Date.)
// If the parsed MM-DD is in the future relative to the reference, assume
// it belongs to the previous year (handles year-boundary edge case).
function parseTimeLabel(timeLabel, referenceDate) {
  const match = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(timeLabel);
  if (!match) return null;
  const [, mm, dd, hh, mn] = match.map(Number);
  // Try with the reference year first.
  let year = referenceDate.getFullYear();
  let candidate = new Date(year, mm - 1, dd, hh, mn);
  // If the candidate is more than a few hours in the future, it must be
  // from the previous year (December → January wrap-around).
  if (candidate.getTime() - referenceDate.getTime() > 6 * 60 * 60 * 1000) {
    candidate = new Date(year - 1, mm - 1, dd, hh, mn);
  }
  return candidate;
}

// Numeric coercion that treats null/undefined/NaN as 0.
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ─── KHDataAnalyzer class ───────────────────────────────────

export class KHDataAnalyzer {
  constructor(apiResponse) {
    this.api = apiResponse || {};
    // Parse fetchedAt; default to "now" if missing.
    this.fetchedAt = this.api.fetchedAt
      ? new Date(this.api.fetchedAt)
      : new Date();
  }

  hasData() {
    return !!(this.api.dogtooth || this.api.whiteWall ||
              (this.api.dogtoothHistory && this.api.dogtoothHistory.length) ||
              (this.api.whiteWallHistory && this.api.whiteWallHistory.length));
  }

  // ─── Overnight snow calculation ───────────────────────────
  // Returns:
  //   { swe_mm, snow_cm, ratio, hours, meanTempC, isRain,
  //     windowStart, windowEnd, windowState, source }
  //
  // Window: yesterday 4 PM → today 9 AM (finalized after 9 AM today),
  // or yesterday 4 PM → now (in_progress, when called before 9 AM).
  overnightSnow() {
    const now = this.fetchedAt;
    const year = now.getFullYear();
    const month = now.getMonth();
    const day = now.getDate();
    const hour = now.getHours();

    // Determine the window bounds.
    // If we're past the freeze hour (>= 9 AM) on the current day,
    // the window is finalized: 4 PM yesterday → 9 AM today.
    // Otherwise, the window is in progress: 4 PM yesterday → now.
    const windowStart = new Date(year, month, day - 1, OVERNIGHT_START_HOUR, 0);
    let windowEnd;
    let windowState;
    if (hour >= OVERNIGHT_FREEZE_HOUR) {
      windowEnd = new Date(year, month, day, OVERNIGHT_FREEZE_HOUR, 0);
      windowState = 'finalized';
    } else {
      windowEnd = new Date(now);
      windowState = 'in_progress';
    }

    // Filter history rows to those inside the window.
    const history = this.api.dogtoothHistory || [];
    const inWindow = [];
    for (const row of history) {
      const t = parseTimeLabel(row.timeLabel, now);
      if (!t) continue;
      if (t.getTime() < windowStart.getTime()) continue;
      if (t.getTime() > windowEnd.getTime()) continue;
      inWindow.push({ time: t, row });
    }

    // No data in the window → return zeros.
    if (inWindow.length === 0) {
      return {
        swe_mm: 0,
        snow_cm: 0,
        ratio: 0,
        hours: 0,
        meanTempC: null,
        isRain: false,
        windowStart,
        windowEnd,
        windowState,
        source: 'no data in window',
      };
    }

    // Sum SWE (mm) and compute mean temp.
    let swe_mm = 0;
    let tempSum = 0;
    let tempCount = 0;
    for (const { row } of inWindow) {
      swe_mm += num(row.values?.[D_PRECIP]);
      const t = row.values?.[D_TEMP];
      if (t !== null && t !== undefined && Number.isFinite(Number(t))) {
        tempSum += Number(t);
        tempCount++;
      }
    }
    const meanTempC = tempCount > 0 ? tempSum / tempCount : null;

    // Determine snow vs rain.
    const isRain = meanTempC !== null && meanTempC > RAIN_TEMP_C;
    const ratio = isRain ? 0 : snowWaterRatio(meanTempC ?? -5);
    const snow_cm = isRain ? 0 : (swe_mm * ratio) / 10;  // mm * ratio = mm of snow, /10 = cm

    return {
      swe_mm: Math.round(swe_mm * 100) / 100,
      snow_cm: Math.round(snow_cm * 100) / 100,
      ratio,
      hours: inWindow.length,
      meanTempC: meanTempC !== null ? Math.round(meanTempC * 10) / 10 : null,
      isRain,
      windowStart,
      windowEnd,
      windowState,
      source: `${inWindow.length}h of dogtooth history`,
    };
  }

  // ─── Recent wind (vector-averaged) ────────────────────────
  // Returns:
  //   { avgKph, dominantDir, gustKph, sampleCount, source }
  //
  // Uses last `hours` hours of WhiteWall history.
  // Vector mean weighted by wind speed: avoids the 359°/1° → 180° trap.
  // Falls back to current whiteWall snapshot if no history is available.
  recentWind(hours = 12) {
    const now = this.fetchedAt;
    const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const history = this.api.whiteWallHistory || [];

    // Filter to last `hours` hours.
    const samples = [];
    for (const row of history) {
      const t = parseTimeLabel(row.timeLabel, now);
      if (!t) continue;
      if (t.getTime() < cutoff.getTime()) continue;
      if (t.getTime() > now.getTime()) continue;
      const dir = num(row.values?.[W_DIR]);
      const wind = num(row.values?.[W_WIND]);
      const gust = num(row.values?.[W_GUST]);
      samples.push({ dir, wind, gust });
    }

    // Empty → fall back to snapshot.
    if (samples.length === 0) {
      const snap = this.api.whiteWall;
      if (snap) {
        return {
          avgKph: num(snap.wind),
          dominantDir: num(snap.dir),
          gustKph: num(snap.gust ?? snap.wind),
          sampleCount: 0,
          source: 'snapshot fallback',
        };
      }
      // No snapshot either.
      return {
        avgKph: 0,
        dominantDir: 0,
        gustKph: 0,
        sampleCount: 0,
        source: 'no data',
      };
    }

    // Vector mean weighted by wind speed.
    // Each sample contributes (wind × cos(dir), wind × sin(dir)).
    // Resulting direction is atan2(sumSin, sumCos).
    let sumU = 0;  // east component (x)
    let sumV = 0;  // north component (y)
    let sumSpeed = 0;
    let maxGust = 0;
    for (const s of samples) {
      const rad = (s.dir * Math.PI) / 180;
      sumU += s.wind * Math.sin(rad);
      sumV += s.wind * Math.cos(rad);
      sumSpeed += s.wind;
      if (s.gust > maxGust) maxGust = s.gust;
    }

    const avgKph = sumSpeed / samples.length;
    let dominantDir = (Math.atan2(sumU, sumV) * 180) / Math.PI;
    // Normalize to [0, 360)
    if (dominantDir < 0) dominantDir += 360;
    if (dominantDir >= 360) dominantDir -= 360;

    return {
      avgKph: Math.round(avgKph * 10) / 10,
      dominantDir: Math.round(dominantDir),
      gustKph: Math.round(maxGust),
      sampleCount: samples.length,
      source: `${samples.length}h whiteWall history (vector mean)`,
    };
  }

  // ─── Temperature range over last N hours ──────────────────
  // Returns: { minC, maxC, meanC, sampleCount, source }
  temperatureRange(hours = 24) {
    const now = this.fetchedAt;
    const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const history = this.api.dogtoothHistory || [];

    let minC = Infinity;
    let maxC = -Infinity;
    let sum = 0;
    let count = 0;
    for (const row of history) {
      const t = parseTimeLabel(row.timeLabel, now);
      if (!t) continue;
      if (t.getTime() < cutoff.getTime()) continue;
      if (t.getTime() > now.getTime()) continue;
      const temp = row.values?.[D_TEMP];
      if (temp === null || temp === undefined) continue;
      const n = Number(temp);
      if (!Number.isFinite(n)) continue;
      if (n < minC) minC = n;
      if (n > maxC) maxC = n;
      sum += n;
      count++;
    }

    if (count === 0) {
      return { minC: null, maxC: null, meanC: null, sampleCount: 0, source: 'no data' };
    }
    return {
      minC: Math.round(minC * 10) / 10,
      maxC: Math.round(maxC * 10) / 10,
      meanC: Math.round((sum / count) * 10) / 10,
      sampleCount: count,
      source: `${count}h dogtooth history`,
    };
  }

  // ─── Snowpack change over last N hours ────────────────────
  // Returns: { delta_cm, latest_cm, earliest_cm, source }
  // Uses Dogtooth HS (column index 4).
  snowpackChange(hours = 24) {
    const now = this.fetchedAt;
    const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const history = this.api.dogtoothHistory || [];

    const samples = [];
    for (const row of history) {
      const t = parseTimeLabel(row.timeLabel, now);
      if (!t) continue;
      if (t.getTime() < cutoff.getTime()) continue;
      if (t.getTime() > now.getTime()) continue;
      const hs = Number(row.values?.[4]);  // HS = total snowpack depth column
      if (!Number.isFinite(hs)) continue;
      samples.push({ time: t, hs });
    }

    if (samples.length < 2) {
      return { delta_cm: 0, latest_cm: null, earliest_cm: null, source: 'insufficient data' };
    }
    samples.sort((a, b) => a.time - b.time);
    const earliest_cm = samples[0].hs;
    const latest_cm = samples[samples.length - 1].hs;
    return {
      delta_cm: Math.round((latest_cm - earliest_cm) * 10) / 10,
      latest_cm,
      earliest_cm,
      source: `${samples.length} samples over ${hours}h`,
    };
  }
}
