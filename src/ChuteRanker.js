// src/ChuteRanker.js
// Scores winter-chute POIs based on today's weather conditions.
// Pure JavaScript: no DOM, no fetch, deterministic.
//
// Conforms to SPEC v0.7 § 3.7.
// Tests: tests/ChuteRanker.test.js (R1-R10).
//
// Formula:
//   score (0-100) = 100 * (
//       0.40 * snow_score
//     + 0.30 * direction_score
//     + 0.15 * slope_score
//     + 0.15 * trust_score
//   )
//
// Where each sub-score is in [0, 1]:
//   snow_score      = min(snow_cm / SNOW_FULL_CM, 1)
//   direction_score = blend(1.0, raw_dir_match, transport_factor)
//   slope_score     = how well chute mid-slope matches IDEAL band
//   trust_score     = 0.5*skiedThisSeason + 0.5*patrolControlled (capped at 1)
//
// transport_factor scales how much the wind direction matters:
//   0 below TRANSPORT_THRESHOLD_LOW kph (calm: direction doesn't matter)
//   1 above TRANSPORT_THRESHOLD_HIGH kph (windy: direction dominates)
//   linear ramp in between

// ─── Constants ──────────────────────────────────────────────

// Snow amount (cm) at which snow_score saturates at 1.0
const SNOW_FULL_CM = 25;

// Wind speed (kph) at which wind transport begins / saturates
const TRANSPORT_THRESHOLD_LOW = 15;
const TRANSPORT_THRESHOLD_HIGH = 30;

// Ideal slope band for KH winter chutes
const SLOPE_IDEAL_MIN = 38;
const SLOPE_IDEAL_MAX = 48;
// Slope angles outside this wider band get 0 from slope_score
const SLOPE_HARD_MIN = 25;
const SLOPE_HARD_MAX = 60;

// Factor weights (must sum to 1.0)
const WEIGHTS = {
  snow:      0.40,
  direction: 0.30,
  slope:     0.15,
  trust:     0.15,
};

// 16-point compass directions, in degrees
const COMPASS_16_DEG = {
  N:    0,
  NNE:  22.5,
  NE:   45,
  ENE:  67.5,
  E:    90,
  ESE:  112.5,
  SE:   135,
  SSE:  157.5,
  S:    180,
  SSW:  202.5,
  SW:   225,
  WSW:  247.5,
  W:    270,
  WNW:  292.5,
  NW:   315,
  NNW:  337.5,
};

// ─── Helpers ────────────────────────────────────────────────

function clamp(x, min, max) {
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

// Angular distance between two bearings (0-360), result in 0-180.
function angularDistance(a, b) {
  const diff = Math.abs(((a - b + 540) % 360) - 180);
  return diff;
}

// Map a compass direction string ("NW") to degrees.
// Returns null if the string is invalid.
function compassToDeg(str) {
  if (typeof str !== 'string') return null;
  const key = str.toUpperCase();
  return COMPASS_16_DEG[key] ?? null;
}

// ─── Sub-score calculations ─────────────────────────────────

// Snow score: linear ramp from 0 at 0cm to 1.0 at SNOW_FULL_CM.
// If isRain=true, snow_score = 0 regardless of amount.
function calcSnowScore(overnight) {
  if (!overnight) return 0;
  if (overnight.isRain) return 0;
  const cm = Number(overnight.snow_cm) || 0;
  return clamp(cm / SNOW_FULL_CM, 0, 1);
}

// Transport factor: how much wind direction matters today.
// 0 = calm, direction doesn't matter
// 1 = strong wind, direction is everything
function calcTransportFactor(avgKph) {
  const speed = Number(avgKph) || 0;
  if (speed <= TRANSPORT_THRESHOLD_LOW) return 0;
  if (speed >= TRANSPORT_THRESHOLD_HIGH) return 1;
  return (speed - TRANSPORT_THRESHOLD_LOW) /
         (TRANSPORT_THRESHOLD_HIGH - TRANSPORT_THRESHOLD_LOW);
}

// Raw direction match: 1.0 if wind direction == chute preference,
// 0.0 if 180° opposite, linear in between.
// chuteDir and windDir are in degrees (0-360).
function calcRawDirectionMatch(chuteDirDeg, windDirDeg) {
  const dist = angularDistance(chuteDirDeg, windDirDeg);
  // dist is 0-180. Score 1.0 at 0, 0.0 at 180.
  return 1 - (dist / 180);
}

// Direction score with wind-transport blending.
// When wind is calm, direction is neutral (1.0).
// When wind is strong, direction depends on match quality.
function calcDirectionScore(chute, wind) {
  if (!wind || !chute || !chute.stormDirPreference) return 0.5;
  const chuteDir = compassToDeg(chute.stormDirPreference);
  if (chuteDir === null) return 0.5;
  const transport = calcTransportFactor(wind.avgKph);
  const rawMatch = calcRawDirectionMatch(chuteDir, Number(wind.dominantDir) || 0);
  // Blend: calm conditions → 1.0 (neutral),  strong wind → rawMatch
  return (1 - transport) * 1.0 + transport * rawMatch;
}

// Slope score: 1.0 if chute midpoint falls in IDEAL band, ramps down.
// Outside HARD band → 0.
function calcSlopeScore(chute) {
  const mid = (Number(chute.slopeMin_deg) + Number(chute.slopeMax_deg)) / 2;
  if (Number.isNaN(mid)) return 0.5;
  if (mid < SLOPE_HARD_MIN || mid > SLOPE_HARD_MAX) return 0;
  if (mid >= SLOPE_IDEAL_MIN && mid <= SLOPE_IDEAL_MAX) return 1.0;
  // Outside ideal but inside hard range: linear ramp
  if (mid < SLOPE_IDEAL_MIN) {
    return (mid - SLOPE_HARD_MIN) / (SLOPE_IDEAL_MIN - SLOPE_HARD_MIN);
  }
  return (SLOPE_HARD_MAX - mid) / (SLOPE_HARD_MAX - SLOPE_IDEAL_MAX);
}

// Trust score: 0.5 per signal, capped at 1.0.
function calcTrustScore(chute) {
  let s = 0;
  if (chute.skiedThisSeason === true) s += 0.5;
  if (chute.patrolControlled === true) s += 0.5;
  return clamp(s, 0, 1);
}

// ─── Main scoring function ──────────────────────────────────

function scoreChute(chute, weather) {
  const snowS  = calcSnowScore(weather?.overnight);
  const dirS   = calcDirectionScore(chute, weather?.wind);
  const slopeS = calcSlopeScore(chute);
  const trustS = calcTrustScore(chute);

  const weighted =
      WEIGHTS.snow      * snowS
    + WEIGHTS.direction * dirS
    + WEIGHTS.slope     * slopeS
    + WEIGHTS.trust     * trustS;

  // Convert to 0-100, round to whole number
  return Math.round(weighted * 100);
}

// ─── ChuteRanker class ──────────────────────────────────────

export class ChuteRanker {
  constructor(options = {}) {
    // No options used yet; placeholder for future config.
    this.options = options;
  }

  // Score and rank a list of POIs.
  // Returns array of POIs with `score` field added for winter-chutes.
  // Non-winter-chute POIs are passed through unchanged (no score).
  // Winter chutes are sorted by score descending; non-chutes preserve order.
  rank(pois, weather) {
    if (!Array.isArray(pois) || pois.length === 0) return [];

    // Score each POI
    const scored = pois.map(poi => {
      if (poi.type === 'winter-chute') {
        return { ...poi, score: scoreChute(poi, weather) };
      }
      return { ...poi };  // pass through, no score
    });

    // Sort: winter-chutes by score desc, others stable
    return scored.sort((a, b) => {
      const aIsChute = a.type === 'winter-chute';
      const bIsChute = b.type === 'winter-chute';
      if (aIsChute && bIsChute) return b.score - a.score;
      if (aIsChute && !bIsChute) return -1;  // chutes first
      if (!aIsChute && bIsChute) return 1;
      return 0;  // both non-chutes: preserve original order
    });
  }

  // Score a single chute. Exposed for testing / debugging.
  scoreOne(chute, weather) {
    if (chute.type !== 'winter-chute') return null;
    return scoreChute(chute, weather);
  }

  // Expose the sub-score breakdown for explainability.
  // Useful for UI: "Why did this chute score 73?"
  explainScore(chute, weather) {
    if (chute.type !== 'winter-chute') return null;
    return {
      snow:      calcSnowScore(weather?.overnight),
      direction: calcDirectionScore(chute, weather?.wind),
      slope:     calcSlopeScore(chute),
      trust:     calcTrustScore(chute),
      transport: calcTransportFactor(weather?.wind?.avgKph),
      total:     scoreChute(chute, weather),
      weights:   { ...WEIGHTS },
    };
  }
}

// Also export internal helpers for unit testing or use by other modules.
export const RANKER_CONSTANTS = {
  SNOW_FULL_CM,
  TRANSPORT_THRESHOLD_LOW,
  TRANSPORT_THRESHOLD_HIGH,
  SLOPE_IDEAL_MIN,
  SLOPE_IDEAL_MAX,
  WEIGHTS,
};
