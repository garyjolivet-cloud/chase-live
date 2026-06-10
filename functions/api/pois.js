// functions/api/pois.js
// Cloudflare Pages Function — POI catalog endpoint (Step 5).
//
// Per SPEC v0.7 § 3.6.
//
// Routes:
//   GET    /api/pois          → full catalog wrapped in {pois, count, ...}
//   GET    /api/pois?id=X     → single POI or 404
//   GET    /api/pois?type=X   → filtered catalog by type
//   POST   /api/pois          → upsert one POI (admin token required)
//   DELETE /api/pois?id=X     → delete by id (admin token required)
//   OPTIONS /api/pois         → CORS preflight
//
// Bindings (configured on the Pages project):
//   CHUTES_KV     → KV namespace "chase-life-chutes"
//   ADMIN_TOKEN   → secret string (env var)
//
// Storage model:
//   Single KV key "catalog" holds a JSON array of POI records.

import { validatePOI } from './_poi-validator.js';

const CATALOG_KEY = 'catalog';
const SCHEMA_VERSION = '0.7';

// ─── CORS ───────────────────────────────────────────────────

// Allow the back-office app (chase-life-admin.pages.dev) plus null/local
// origins for curl, local dev, and tools that don't send Origin.
const ALLOWED_ORIGINS = new Set([
  'https://chase-life-admin.pages.dev',
  'http://localhost:5173',         // vite dev default
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'null',
]);

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : '';
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}

// ─── Response helpers ───────────────────────────────────────

function jsonResponse(obj, status, request) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(request),
    },
  });
}

function errorResponse(message, status, request, extra = {}) {
  return jsonResponse({ error: message, ...extra }, status, request);
}

// ─── KV helpers ─────────────────────────────────────────────

async function readCatalog(kv) {
  const raw = await kv.get(CATALOG_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Catalog JSON parse failed:', err);
    return [];
  }
}

async function writeCatalog(kv, catalog) {
  await kv.put(CATALOG_KEY, JSON.stringify(catalog));
}

// ─── Auth ───────────────────────────────────────────────────

// Constant-time string comparison to avoid timing attacks.
// (Sub-millisecond difference is unlikely to matter at this scale, but the
// implementation is trivial so we do it right.)
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Returns null if authorized, else a Response (401/500) to short-circuit.
function checkAuth(request, env) {
  if (!env.ADMIN_TOKEN || typeof env.ADMIN_TOKEN !== 'string') {
    return errorResponse(
      'ADMIN_TOKEN env var is not configured on this deployment.',
      500,
      request
    );
  }
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) {
    return errorResponse(
      'Missing or malformed Authorization header (expected "Bearer <token>")',
      401,
      request
    );
  }
  if (!safeEqual(match[1], env.ADMIN_TOKEN)) {
    return errorResponse('Invalid admin token', 401, request);
  }
  return null;  // OK
}

// ─── Handlers ───────────────────────────────────────────────

export async function onRequestOptions({ request }) {
  // CORS preflight. Always 204 No Content with the headers set.
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.CHUTES_KV) {
    return errorResponse(
      'CHUTES_KV binding is missing on this deployment. Check Pages → Settings → Bindings.',
      500,
      request
    );
  }

  let catalog;
  try {
    catalog = await readCatalog(env.CHUTES_KV);
  } catch (err) {
    console.error('Failed to read catalog from KV:', err);
    return errorResponse('Failed to read catalog from KV', 500, request);
  }

  const url = new URL(request.url);
  const idParam = url.searchParams.get('id');
  const typeParam = url.searchParams.get('type');

  if (idParam) {
    const found = catalog.find((poi) => poi.id === idParam);
    if (!found) {
      return errorResponse(`POI not found: ${idParam}`, 404, request);
    }
    return jsonResponse(found, 200, request);
  }

  let results = catalog;
  if (typeParam) {
    results = catalog.filter((poi) => poi.type === typeParam);
  }

  return jsonResponse(
    {
      pois: results,
      count: results.length,
      schemaVersion: SCHEMA_VERSION,
      lastFetched: new Date().toISOString(),
    },
    200,
    request
  );
}

export async function onRequestPost({ request, env }) {
  if (!env.CHUTES_KV) {
    return errorResponse('CHUTES_KV binding missing', 500, request);
  }

  // Auth first — don't even parse the body of an unauthed request.
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  // Body parse.
  let poi;
  try {
    poi = await request.json();
  } catch (err) {
    return errorResponse('Request body must be valid JSON', 400, request);
  }

  // Validate.
  const { valid, errors } = validatePOI(poi);
  if (!valid) {
    return errorResponse('Validation failed', 400, request, { errors });
  }

  // Upsert into the catalog.
  let catalog;
  try {
    catalog = await readCatalog(env.CHUTES_KV);
  } catch (err) {
    return errorResponse('Failed to read catalog from KV', 500, request);
  }

  const now = new Date().toISOString();
  const existingIdx = catalog.findIndex((p) => p.id === poi.id);
  let savedPoi;
  if (existingIdx >= 0) {
    // Update: preserve original createdAt
    savedPoi = {
      ...poi,
      createdAt: catalog[existingIdx].createdAt || now,
      updatedAt: now,
    };
    catalog[existingIdx] = savedPoi;
  } else {
    // Create
    savedPoi = {
      ...poi,
      createdAt: now,
      updatedAt: now,
    };
    catalog.push(savedPoi);
  }

  try {
    await writeCatalog(env.CHUTES_KV, catalog);
  } catch (err) {
    console.error('Failed to write catalog to KV:', err);
    return errorResponse('Failed to write catalog to KV', 500, request);
  }

  return jsonResponse(
    {
      saved: savedPoi,
      action: existingIdx >= 0 ? 'updated' : 'created',
    },
    existingIdx >= 0 ? 200 : 201,
    request
  );
}

export async function onRequestDelete({ request, env }) {
  if (!env.CHUTES_KV) {
    return errorResponse('CHUTES_KV binding missing', 500, request);
  }

  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const idParam = url.searchParams.get('id');
  if (!idParam) {
    return errorResponse('DELETE requires an ?id=... query parameter', 400, request);
  }

  let catalog;
  try {
    catalog = await readCatalog(env.CHUTES_KV);
  } catch (err) {
    return errorResponse('Failed to read catalog from KV', 500, request);
  }

  const idx = catalog.findIndex((p) => p.id === idParam);
  if (idx < 0) {
    return errorResponse(`POI not found: ${idParam}`, 404, request);
  }

  const [removed] = catalog.splice(idx, 1);

  try {
    await writeCatalog(env.CHUTES_KV, catalog);
  } catch (err) {
    console.error('Failed to write catalog to KV after delete:', err);
    return errorResponse('Failed to write catalog to KV', 500, request);
  }

  return jsonResponse({ deleted: removed }, 200, request);
}
