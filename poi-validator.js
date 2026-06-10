// functions/api/_poi-validator.js
// Vendored copy of src/POIValidator.js for Cloudflare Pages Functions.
// Pages Functions builds don't reliably import across /src and /functions,
// so this file lives next to pois.js and mirrors the canonical validator.
//
// Keep this in sync with src/POIValidator.js. If they diverge, fix here
// and the source matches, then update SPEC §3.5 if rules changed.

const KH_BBOX = {
  latMin: 50.84,
  latMax: 50.92,
  lonMin: -116.94,
  lonMax: -116.85,
};

const COMPASS_16 = [
  'N',  'NNE', 'NE', 'ENE',
  'E',  'ESE', 'SE', 'SSE',
  'S',  'SSW', 'SW', 'WSW',
  'W',  'WNW', 'NW', 'NNW',
];

const VALID_TYPES = ['winter-chute', 'narrative-poi', 'general'];
const VALID_SEASONS = ['summer', 'winter', 'any'];
const RADIUS_MIN = 5;
const RADIUS_MAX = 100;
const ID_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isInsideKHBbox(latLon) {
  if (!Array.isArray(latLon) || latLon.length !== 2) return false;
  const [lat, lon] = latLon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  return (
    lat >= KH_BBOX.latMin && lat <= KH_BBOX.latMax &&
    lon >= KH_BBOX.lonMin && lon <= KH_BBOX.lonMax
  );
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isNumber(v) {
  return typeof v === 'number' && !isNaN(v) && isFinite(v);
}

function validateCommonFields(poi, errors) {
  if (!isNonEmptyString(poi.id)) {
    errors.push('id is required and must be a non-empty string');
  } else if (!ID_REGEX.test(poi.id)) {
    errors.push(`id "${poi.id}" must be lowercase letters/digits/hyphens only (no spaces or special chars)`);
  }
  if (!isNonEmptyString(poi.name)) {
    errors.push('name is required and must be a non-empty string');
  }
  if (!VALID_TYPES.includes(poi.type)) {
    errors.push(`type must be one of: ${VALID_TYPES.join(', ')} (got "${poi.type}")`);
  }
  if (!Array.isArray(poi.topLatLon) || poi.topLatLon.length !== 2) {
    errors.push('topLatLon is required and must be [lat, lon]');
  } else if (!isInsideKHBbox(poi.topLatLon)) {
    errors.push(`topLatLon ${JSON.stringify(poi.topLatLon)} is outside the KH bounding box`);
  }
  if (!isNumber(poi.radiusMeters)) {
    errors.push('radiusMeters is required and must be a number');
  } else if (poi.radiusMeters < RADIUS_MIN || poi.radiusMeters > RADIUS_MAX) {
    errors.push(`radiusMeters must be between ${RADIUS_MIN} and ${RADIUS_MAX} (got ${poi.radiusMeters})`);
  }
}

function validateWinterChuteFields(poi, errors) {
  if (!COMPASS_16.includes(poi.stormDirPreference)) {
    errors.push(`stormDirPreference must be one of the 16 compass labels (got "${poi.stormDirPreference}")`);
  }
  if (!Array.isArray(poi.bottomLatLon) || poi.bottomLatLon.length !== 2) {
    errors.push('bottomLatLon is required for winter-chute and must be [lat, lon]');
  } else if (!isInsideKHBbox(poi.bottomLatLon)) {
    errors.push(`bottomLatLon ${JSON.stringify(poi.bottomLatLon)} is outside the KH bounding box`);
  }
  if (!isNumber(poi.slopeMin_deg) || !isNumber(poi.slopeMax_deg)) {
    errors.push('slopeMin_deg and slopeMax_deg are required and must be numbers');
  } else if (poi.slopeMin_deg > poi.slopeMax_deg) {
    errors.push(`slopeMin_deg (${poi.slopeMin_deg}) must be <= slopeMax_deg (${poi.slopeMax_deg})`);
  }
  if (!isNumber(poi.widthMin_m) || !isNumber(poi.widthMax_m)) {
    errors.push('widthMin_m and widthMax_m are required and must be numbers');
  } else if (poi.widthMin_m > poi.widthMax_m) {
    errors.push(`widthMin_m (${poi.widthMin_m}) must be <= widthMax_m (${poi.widthMax_m})`);
  }
  if (!isNumber(poi.topElev_m) || !isNumber(poi.bottomElev_m)) {
    errors.push('topElev_m and bottomElev_m are required and must be numbers');
  } else if (poi.topElev_m < poi.bottomElev_m) {
    errors.push(`topElev_m (${poi.topElev_m}) must be >= bottomElev_m (${poi.bottomElev_m})`);
  }
}

function validateNarrativePoiFields(poi, errors) {
  if (!isNonEmptyString(poi.audioUrl)) {
    errors.push('audioUrl is required for narrative-poi (v1 is audio-first)');
  }
  if (!VALID_SEASONS.includes(poi.season)) {
    errors.push(`season must be one of: ${VALID_SEASONS.join(', ')} (got "${poi.season}")`);
  }
}

export function validatePOI(poi) {
  const errors = [];
  if (poi === null || typeof poi !== 'object') {
    return { valid: false, errors: ['poi must be an object'] };
  }
  validateCommonFields(poi, errors);
  if (poi.type === 'winter-chute') {
    validateWinterChuteFields(poi, errors);
  } else if (poi.type === 'narrative-poi') {
    validateNarrativePoiFields(poi, errors);
  }
  return { valid: errors.length === 0, errors };
}
