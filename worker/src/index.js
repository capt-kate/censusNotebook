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
const MAX_BACKUP_BYTES = 4_500_000;
const MAX_AI_RECORD_BYTES = 12_000;
const DEFAULT_AI_INTERPRET_MONTHLY_LIMIT = 50;

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

  if (session.amount_total === 9900) return PRODUCT_TYPES.pro;
  if (session.amount_total === 2000) return PRODUCT_TYPES.extraProject;

  return "";
}

async function findLicenseByEmail(db, email) {
  return db.prepare("SELECT * FROM licenses WHERE email = ? LIMIT 1").bind(email).first();
}

async function findLicenseByKey(db, licenseKey) {
  return db.prepare("SELECT * FROM licenses WHERE license_key = ? LIMIT 1").bind(licenseKey).first();
}

async function ensureCloudBackupTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS cloud_backups (
        license_id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (license_id) REFERENCES licenses(id)
      )`
    )
    .run();
}

async function ensureAiUsageTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ai_usage_monthly (
        license_id TEXT NOT NULL,
        usage_month TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (license_id, usage_month),
        FOREIGN KEY (license_id) REFERENCES licenses(id)
      )`
    )
    .run();
}

function getAiUsageLimit(env) {
  const limit = Number.parseInt(env.AI_INTERPRET_MONTHLY_LIMIT || "", 10);
  return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_AI_INTERPRET_MONTHLY_LIMIT;
}

function getAiUsageMonth(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

async function reserveAiUsage(db, licenseId, limit) {
  await ensureAiUsageTable(db);

  const now = new Date().toISOString();
  const usageMonth = getAiUsageMonth();
  const usage = await db
    .prepare("SELECT request_count FROM ai_usage_monthly WHERE license_id = ? AND usage_month = ? LIMIT 1")
    .bind(licenseId, usageMonth)
    .first();
  const currentCount = Number.parseInt(usage?.request_count, 10) || 0;

  if (currentCount >= limit) {
    return {
      allowed: false,
      usageMonth,
      usageUsed: currentCount,
      usageRemaining: 0,
      usageLimit: limit,
    };
  }

  const nextCount = currentCount + 1;
  await db
    .prepare(
      `INSERT INTO ai_usage_monthly (license_id, usage_month, request_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(license_id, usage_month)
       DO UPDATE SET request_count = excluded.request_count, updated_at = excluded.updated_at`
    )
    .bind(licenseId, usageMonth, nextCount, now, now)
    .run();

  return {
    allowed: true,
    usageMonth,
    usageUsed: nextCount,
    usageRemaining: Math.max(0, limit - nextCount),
    usageLimit: limit,
  };
}

async function refundAiUsage(db, licenseId, usageMonth) {
  if (!licenseId || !usageMonth) return;

  await db
    .prepare(
      `UPDATE ai_usage_monthly
       SET request_count = CASE WHEN request_count > 0 THEN request_count - 1 ELSE 0 END,
           updated_at = ?
       WHERE license_id = ? AND usage_month = ?`
    )
    .bind(new Date().toISOString(), licenseId, usageMonth)
    .run();
}

async function getProLicenseFromRequest(request, env) {
  const url = new URL(request.url);
  let licenseKey = String(url.searchParams.get("licenseKey") || "").trim();

  if (!licenseKey && request.method !== "GET") {
    const body = await request.clone().json().catch(() => ({}));
    licenseKey = String(body.licenseKey || "").trim();
  }

  if (!licenseKey) return { error: "Provide a license key.", status: 400 };

  const license = await findLicenseByKey(env.DB, licenseKey);
  if (!license) return { error: "License not found.", status: 404 };
  if (license.plan !== "pro") return { error: "Cloud backup requires Pro.", status: 403 };

  return { license };
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

async function sendLicenseEmail(env, license, productType) {
  if (!env.RESEND_API_KEY || !env.LICENSE_EMAIL_FROM || !license?.email) {
    console.warn("Skipping license email because email settings are incomplete.");
    return;
  }

  const subject = productType === PRODUCT_TYPES.pro
    ? "Your Census Notebook Pro license"
    : "Your Census Notebook project slot license";
  const planLabel = license.plan === "pro" ? "Pro lifetime" : "Free with extra project slots";
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111827;">
      <h1 style="font-size: 22px;">Census Notebook License</h1>
      <p>Thank you for supporting Census Notebook.</p>
      <p><strong>Plan:</strong> ${planLabel}</p>
      <p><strong>Extra project slots:</strong> ${license.extra_project_slots}</p>
      <p><strong>License key:</strong> <code style="font-size: 16px;">${license.license_key}</code></p>
      <p>To activate your purchase, open Census Notebook, go to <strong>Support &amp; Upgrades</strong>, enter this license key or the email address used at checkout, and click <strong>Restore Purchase</strong>.</p>
    </div>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.LICENSE_EMAIL_FROM,
      to: license.email,
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    console.error("Resend email failed", response.status, message);
    return;
  }
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

  if (license) {
    await sendLicenseEmail(env, license, productType);
  }

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

async function handleGetCloudBackup(request, env) {
  const auth = await getProLicenseFromRequest(request, env);
  if (auth.error) return errorResponse(auth.error, auth.status);

  await ensureCloudBackupTable(env.DB);
  const backup = await env.DB
    .prepare("SELECT data_json, updated_at FROM cloud_backups WHERE license_id = ? LIMIT 1")
    .bind(auth.license.id)
    .first();

  if (!backup) return jsonResponse({ found: false });

  return jsonResponse({
    found: true,
    updatedAt: backup.updated_at,
    data: JSON.parse(backup.data_json),
  });
}

async function handleSaveCloudBackup(request, env) {
  const body = await request.json().catch(() => ({}));
  const licenseKey = String(body.licenseKey || "").trim();
  const data = body.data;

  if (!licenseKey) return errorResponse("Provide a license key.", 400);
  if (!data || !Array.isArray(data.projects)) return errorResponse("Backup data must include projects.", 400);

  const dataJson = JSON.stringify(data);
  if (new TextEncoder().encode(dataJson).length > MAX_BACKUP_BYTES) {
    return errorResponse("Backup is too large for cloud storage.", 413);
  }

  const license = await findLicenseByKey(env.DB, licenseKey);
  if (!license) return errorResponse("License not found.", 404);
  if (license.plan !== "pro") return errorResponse("Cloud backup requires Pro.", 403);

  await ensureCloudBackupTable(env.DB);
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO cloud_backups (license_id, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(license_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
    )
    .bind(license.id, dataJson, now, now)
    .run();

  return jsonResponse({ saved: true, updatedAt: now });
}

function getOpenAiOutputText(payload) {
  if (payload?.output_text) return String(payload.output_text).trim();

  return (payload?.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function handleAiInterpretRecord(request, env) {
  if (!env.OPENAI_API_KEY) return errorResponse("AI is not configured yet.", 503);

  const body = await request.json().catch(() => ({}));
  const licenseKey = String(body.licenseKey || "").trim();
  const record = body.record || {};

  if (!licenseKey) return errorResponse("Provide a license key.", 400);
  if (!record || typeof record !== "object") return errorResponse("Provide a census record.", 400);

  const license = await findLicenseByKey(env.DB, licenseKey);
  if (!license) return errorResponse("License not found.", 404);
  if (license.plan !== "pro") return errorResponse("AI Interpret requires Pro.", 403);

  const recordJson = JSON.stringify({
    year: record.year || "",
    name: record.name || "",
    location: record.location || "",
    household: record.household || "",
    notes: record.notes || "",
    projectName: record.projectName || "",
  });

  if (new TextEncoder().encode(recordJson).length > MAX_AI_RECORD_BYTES) {
    return errorResponse("Record is too large to interpret.", 413);
  }

  const usage = await reserveAiUsage(env.DB, license.id, getAiUsageLimit(env));
  if (!usage.allowed) {
    return jsonResponse({
      error: `Monthly AI Interpret limit reached. You have used ${usage.usageUsed} of ${usage.usageLimit} requests for ${usage.usageMonth}.`,
      usageMonth: usage.usageMonth,
      usageUsed: usage.usageUsed,
      usageRemaining: usage.usageRemaining,
      usageLimit: usage.usageLimit,
    }, 429);
  }

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-5.2",
        instructions: [
          "You are helping a genealogist interpret one census record.",
          "Use only the record details provided. Do not invent facts.",
          "Be concise, practical, and cautious. Call out uncertainty.",
          "Return plain text with these headings: Summary, Clues, Possible Follow-Up, Cautions.",
        ].join(" "),
        input: `Interpret this Census Notebook record for genealogy research:\n${recordJson}`,
        max_output_tokens: 900,
      }),
    });
  } catch (error) {
    await refundAiUsage(env.DB, license.id, usage.usageMonth);
    return errorResponse(error.message || "AI interpretation failed.", 502);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    await refundAiUsage(env.DB, license.id, usage.usageMonth);
    return errorResponse(payload.error?.message || "AI interpretation failed.", response.status);
  }

  const interpretation = getOpenAiOutputText(payload);
  if (!interpretation) {
    await refundAiUsage(env.DB, license.id, usage.usageMonth);
    return errorResponse("AI did not return an interpretation.", 502);
  }

  return jsonResponse({ interpretation, ...usage });
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

      if (request.method === "GET" && url.pathname === "/cloud-backup") {
        return handleGetCloudBackup(request, env);
      }

      if (request.method === "POST" && url.pathname === "/cloud-backup") {
        return handleSaveCloudBackup(request, env);
      }

      if (request.method === "POST" && url.pathname === "/ai/interpret-record") {
        return handleAiInterpretRecord(request, env);
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
