// functions/api/pois.js
// Cloudflare Pages Function — POI catalog endpoint.
//
// Per SPEC v0.7 § 3.6.
//
// Step 4 scope: GET only.
//   GET /api/pois        → full catalog
//   GET /api/pois?id=... → single POI by id
//
// Step 5 will add POST/DELETE with admin token auth + CORS for back office.
//
// Storage model:
//   The full catalog lives under a single KV key named "catalog".
//   The value is a JSON array of POI records (see SPEC § 3.5).
//   Returning the entire catalog in one read is fine for our scale
//   (~100 POIs × ~2KB = ~200KB, well under KV's 25MB value limit).
//
// Bindings (configured in Cloudflare Pages → Settings → Bindings):
//   CHUTES_KV   → KV namespace "chase-life-chutes"
//
// (MEDIA_BUCKET binding exists but is unused here; used by /api/pois/upload in Step 6.)

const CATALOG_KEY = 'catalog';
const SCHEMA_VERSION = '0.7';

// ─── Helpers ────────────────────────────────────────────────

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status);
}

// Read the catalog array from KV.
// Returns [] if the key doesn't exist or contains invalid JSON.
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

// ─── Handler ────────────────────────────────────────────────

export async function onRequestGet({ request, env }) {
  // Defensive: confirm the KV binding actually exists.
  if (!env.CHUTES_KV) {
    return errorResponse(
      'CHUTES_KV binding is missing on this deployment. Check Cloudflare Pages → Settings → Bindings.',
      500
    );
  }

  let catalog;
  try {
    catalog = await readCatalog(env.CHUTES_KV);
  } catch (err) {
    console.error('Failed to read catalog from KV:', err);
    return errorResponse('Failed to read catalog from KV', 500);
  }

  // Filter by id query parameter if provided.
  const url = new URL(request.url);
  const idParam = url.searchParams.get('id');
  const typeParam = url.searchParams.get('type');

  if (idParam) {
    const found = catalog.find((poi) => poi.id === idParam);
    if (!found) {
      return jsonResponse({ error: `POI not found: ${idParam}` }, 404);
    }
    return jsonResponse(found);
  }

  // Optional filter by type.
  let results = catalog;
  if (typeParam) {
    results = catalog.filter((poi) => poi.type === typeParam);
  }

  return jsonResponse({
    pois: results,
    count: results.length,
    schemaVersion: SCHEMA_VERSION,
    lastFetched: new Date().toISOString(),
  });
}

// Note: methods other than GET (POST, DELETE) are not yet handled.
// Cloudflare Pages will return a 405 automatically when only onRequestGet
// is exported. Step 5 will add onRequestPost and onRequestDelete with auth.
