// functions/api/upload.js
// Cloudflare Pages Function — image upload endpoint for POI media.
//
// Per SPEC v0.7 § 3.6 + § 3.5 (images sub-object).
//
// Routes:
//   POST    /api/upload  → upload one image to R2 (admin token required)
//   OPTIONS /api/upload  → CORS preflight
//
// Request format:
//   Content-Type: multipart/form-data
//   Form fields:
//     file:    the image file (required)
//     poiId:   the POI id this image belongs to (required)
//     field:   which image slot: main, entrance, exit, runout, profile,
//              extra1, extra2, extra3 (required)
//
// Response (success):
//   { url, key, size, contentType, poiId, field }
//
// Response (error):
//   { error: "..." } with appropriate HTTP status
//
// Bindings (configured on the Pages project):
//   MEDIA_BUCKET → R2 bucket "chase-life-media"
//   ADMIN_TOKEN  → secret string (env var)

// ─── Constants ──────────────────────────────────────────────

const MAX_BYTES = 5 * 1024 * 1024;  // 5 MB
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};
const ALLOWED_FIELDS = new Set([
  'main', 'entrance', 'exit', 'runout', 'profile',
  'extra1', 'extra2', 'extra3',
]);

// CORS: open for now; future Step 8 may tighten to back office origin only.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

// ─── Helpers ────────────────────────────────────────────────

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// Pull bearer token from Authorization header.
// Returns the token string or null.
function extractBearerToken(request) {
  const auth = request.headers.get('authorization');
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  return match[1].trim();
}

// Constant-time comparison helper.
// Avoids timing side-channels on token comparison.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Validate that a string is a safe id segment.
// Lowercase letters, digits, hyphens only; 1-64 chars.
// Prevents path traversal in R2 keys.
function isSafeId(s) {
  return typeof s === 'string' && /^[a-z0-9-]{1,64}$/.test(s);
}

// ─── OPTIONS handler (CORS preflight) ───────────────────────

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// ─── POST handler ───────────────────────────────────────────

export async function onRequestPost({ request, env }) {
  // Verify bindings exist.
  if (!env.MEDIA_BUCKET) {
    return errorResponse(
      'MEDIA_BUCKET binding is missing. Check Cloudflare Pages → Settings → Bindings.',
      500
    );
  }
  if (!env.ADMIN_TOKEN) {
    return errorResponse(
      'ADMIN_TOKEN secret is missing. Check Cloudflare Pages → Settings → Variables and Secrets.',
      500
    );
  }

  // Auth.
  const presented = extractBearerToken(request);
  if (!presented) {
    return errorResponse(
      'Missing or malformed Authorization header (expected "Bearer <token>")',
      401
    );
  }
  if (!timingSafeEqual(presented, env.ADMIN_TOKEN)) {
    return errorResponse('Invalid admin token', 401);
  }

  // Parse multipart form data.
  let formData;
  try {
    formData = await request.formData();
  } catch (err) {
    return errorResponse(
      'Request body must be multipart/form-data',
      400
    );
  }

  const file = formData.get('file');
  const poiId = formData.get('poiId');
  const field = formData.get('field');

  // Validate required fields.
  if (!file || typeof file === 'string') {
    return errorResponse('Missing "file" in form data', 400);
  }
  if (!poiId || typeof poiId !== 'string') {
    return errorResponse('Missing "poiId" in form data', 400);
  }
  if (!field || typeof field !== 'string') {
    return errorResponse('Missing "field" in form data', 400);
  }

  // Validate id and field for safety.
  if (!isSafeId(poiId)) {
    return errorResponse(
      'Invalid "poiId" — must be lowercase letters, digits, hyphens only (max 64 chars)',
      400
    );
  }
  if (!ALLOWED_FIELDS.has(field)) {
    return errorResponse(
      `Invalid "field" — must be one of: ${[...ALLOWED_FIELDS].join(', ')}`,
      400
    );
  }

  // Validate file type.
  const contentType = file.type || 'application/octet-stream';
  if (!ALLOWED_TYPES.has(contentType)) {
    return errorResponse(
      `Unsupported content type "${contentType}" — must be one of: ${[...ALLOWED_TYPES].join(', ')}`,
      415
    );
  }

  // Validate file size.
  if (file.size > MAX_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(2);
    return errorResponse(
      `File too large (${mb} MB) — max is ${MAX_BYTES / 1024 / 1024} MB`,
      413
    );
  }
  if (file.size === 0) {
    return errorResponse('File is empty', 400);
  }

  // Build the R2 object key.
  // Pattern: pois/<poiId>/<field>-<timestamp>.<ext>
  // Timestamp keeps history if a field is re-uploaded — old versions stay
  // in R2 but aren't referenced; can be cleaned up later if needed.
  const ext = EXT_BY_TYPE[contentType];
  const timestamp = Date.now();
  const key = `pois/${poiId}/${field}-${timestamp}.${ext}`;

  // Write to R2.
  try {
    await env.MEDIA_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType },
      customMetadata: {
        poiId,
        field,
        uploadedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('R2 write failed:', err);
    return errorResponse(`Failed to write to R2: ${err.message}`, 500);
  }

  // Build the public URL using the actual R2.dev public subdomain
  // (enabled in Step 6 verification — pub-deb8eae1e0eb4b55a9753722f77b21b0.r2.dev).
  const url = `https://pub-deb8eae1e0eb4b55a9753722f77b21b0.r2.dev/${key}`;

  return jsonResponse({
    saved: true,
    url,
    key,
    size: file.size,
    contentType,
    poiId,
    field,
    uploadedAt: new Date().toISOString(),
  });
}
