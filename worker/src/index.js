const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature, Authorization",
};

const PRODUCT_TYPES = {
  pro: "pro_lifetime",
  extraProject: "extra_project_slot",
  coffee: "coffee",
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function generateLicenseKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const code = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `CN-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;

  let result = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    result |= leftBytes[index] ^ rightBytes[index];
  }
  return result === 0;
}

async function hmacSha256Hex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyStripeSignature(rawBody, stripeSignature, webhookSecret) {
  if (!stripeSignature) throw new Error("Missing Stripe-Signature header.");
  if (!webhookSecret) throw new Error("Missing STRIPE_WEBHOOK_SECRET.");

  const parts = Object.fromEntries(
    stripeSignature.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    })
  );
  const timestamp = parts.t;
  const signatures = stripeSignature
    .split(",")
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));

  if (!timestamp || signatures.length === 0) throw new Error("Invalid Stripe signature header.");

  const expectedSignature = await hmacSha256Hex(webhookSecret, `${timestamp}.${rawBody}`);
  const isValid = signatures.some((signature) => timingSafeEqual(signature, expectedSignature));
  if (!isValid) throw new Error("Stripe signature verification failed.");
}

function getProductType(session, env) {
  if (session.payment_link === env.STRIPE_PRO_PAYMENT_LINK_ID) return PRODUCT_TYPES.pro;
  if (session.payment_link === env.STRIPE_EXTRA_PROJECT_PAYMENT_LINK_ID) return PRODUCT_TYPES.extraProject;
  if (session.payment_link === env.STRIPE_COFFEE_PAYMENT_LINK_ID) return PRODUCT_TYPES.coffee;

  const metadataType = session.metadata?.product_type || session.metadata?.license_type;
  if (Object.values(PRODUCT_TYPES).includes(metadataType)) return metadataType;

  return "";
}

async function findLicenseByEmail(db, email) {
  return db.prepare("SELECT * FROM licenses WHERE email = ? LIMIT 1").bind(email).first();
}

async function findLicenseByKey(db, licenseKey) {
  return db.prepare("SELECT * FROM licenses WHERE license_key = ? LIMIT 1").bind(licenseKey).first();
}

async function createLicense(db, email, stripeCustomerId = "") {
  const now = new Date().toISOString();
  let licenseKey = generateLicenseKey();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const licenseId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO licenses (
            id, email, license_key, plan, extra_project_slots, stripe_customer_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'free', 0, ?, ?, ?)`
        )
        .bind(licenseId, email, licenseKey, stripeCustomerId, now, now)
        .run();
      return findLicenseByKey(db, licenseKey);
    } catch (error) {
      licenseKey = generateLicenseKey();
      if (attempt === 4) throw error;
    }
  }

  throw new Error("Could not create license.");
}

async function findOrCreateLicense(db, email, stripeCustomerId = "") {
  const existing = await findLicenseByEmail(db, email);
  if (existing) return existing;
  return createLicense(db, email, stripeCustomerId);
}

async function recordPurchase(db, { licenseId, stripeSessionId, productType, amount }) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO purchases (
        id, license_id, stripe_session_id, product_type, amount, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), licenseId, stripeSessionId, productType, amount || 0, now)
    .run();
}

async function applyPurchase(db, session, productType) {
  const email = normalizeEmail(session.customer_details?.email || session.customer_email);
  if (!email) throw new Error("Stripe session did not include a customer email.");

  const license = await findOrCreateLicense(db, email, session.customer || "");
  const existingPurchase = await db
    .prepare("SELECT id FROM purchases WHERE stripe_session_id = ? LIMIT 1")
    .bind(session.id)
    .first();

  if (existingPurchase) return license;

  const now = new Date().toISOString();
  if (productType === PRODUCT_TYPES.pro) {
    await db
      .prepare("UPDATE licenses SET plan = 'pro', stripe_customer_id = COALESCE(NULLIF(?, ''), stripe_customer_id), updated_at = ? WHERE id = ?")
      .bind(session.customer || "", now, license.id)
      .run();
  } else if (productType === PRODUCT_TYPES.extraProject) {
    await db
      .prepare("UPDATE licenses SET extra_project_slots = extra_project_slots + 1, stripe_customer_id = COALESCE(NULLIF(?, ''), stripe_customer_id), updated_at = ? WHERE id = ?")
      .bind(session.customer || "", now, license.id)
      .run();
  }

  await recordPurchase(db, {
    licenseId: license.id,
    stripeSessionId: session.id,
    productType,
    amount: session.amount_total || 0,
  });

  return findLicenseByEmail(db, email);
}

function publicLicensePayload(license) {
  if (!license) return { valid: false };
  return {
    valid: true,
    email: license.email,
    licenseKey: license.license_key,
    plan: license.plan,
    extraProjectSlots: license.extra_project_slots,
    updatedAt: license.updated_at,
  };
}

async function handleStripeWebhook(request, env) {
  const rawBody = await request.text();
  await verifyStripeSignature(rawBody, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);

  const event = JSON.parse(rawBody);
  if (event.type !== "checkout.session.completed") {
    return jsonResponse({ received: true, ignored: true });
  }

  const session = event.data.object;
  const productType = getProductType(session, env);
  if (!productType) return errorResponse("Unknown Stripe product type.", 400);

  const license = productType === PRODUCT_TYPES.coffee
    ? null
    : await applyPurchase(env.DB, session, productType);

  if (productType === PRODUCT_TYPES.coffee) {
    await recordPurchase(env.DB, {
      licenseId: null,
      stripeSessionId: session.id,
      productType,
      amount: session.amount_total || 0,
    });
  }

  return jsonResponse({ received: true, productType, license: publicLicensePayload(license) });
}

async function handleLicenseStatus(request, env) {
  const url = new URL(request.url);
  const licenseKey = String(url.searchParams.get("licenseKey") || "").trim();
  const email = normalizeEmail(url.searchParams.get("email"));

  if (!licenseKey && !email) {
    return errorResponse("Provide licenseKey or email.", 400);
  }

  const license = licenseKey
    ? await findLicenseByKey(env.DB, licenseKey)
    : await findLicenseByEmail(env.DB, email);

  return jsonResponse(publicLicensePayload(license));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/stripe/webhook") {
        return handleStripeWebhook(request, env);
      }

      if (request.method === "GET" && url.pathname === "/license/status") {
        return handleLicenseStatus(request, env);
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ status: "ok" });
      }

      return errorResponse("Not found.", 404);
    } catch (error) {
      return errorResponse(error.message || "Server error.", 500);
    }
  },
};
