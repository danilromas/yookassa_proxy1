import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import { sql, rowToProduct, bodyToRow } from "./products-db.js";

const app = express();
const PORT = process.env.PORT || 8787;

const {
  YOOKASSA_SHOP_ID,
  YOOKASSA_SECRET_KEY,
  PUBLIC_RETURN_URL = "http://localhost:8080/#/payment-result",
  PUBLIC_SITE_URL = "http://localhost:5173",
  PUBLIC_API_URL,
  ALLOWED_ORIGINS = "*",
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SMTP_HOST,
  SMTP_PORT = "587",
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
} = process.env;

if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
  console.warn("⚠️  YOOKASSA_SHOP_ID or YOOKASSA_SECRET_KEY is not set. Requests will fail until you configure them.");
}

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS === "*") {
      return callback(null, true);
    }
    const allowed = ALLOWED_ORIGINS.split(",").map((value) => value.trim());
    if (allowed.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: false,
};

app.use(cors(corsOptions));
app.use(express.json());

const requiredFields = ["fullName", "phone", "totalPrice", "items"];

const expectedWebhookAuth = `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64")}`;

function createMailer() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    return null;
  }

  const port = Number(SMTP_PORT) || 587;
  const secure = port === 465;

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

const mailer = createMailer();

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isValidEmail(email) {
  // Базовая проверка, чтобы отсечь очевидно плохие значения.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function productUrl(productId) {
  return `${String(PUBLIC_SITE_URL).replace(/\/$/, "")}/#/product/${productId}`;
}

function unsubscribeUrl(token) {
  const base = String(PUBLIC_API_URL || PUBLIC_SITE_URL).replace(/\/$/, "");
  return `${base}/api/product-watch/unsubscribe/${encodeURIComponent(token)}`;
}

async function notifyWatchersInStock(product) {
  if (!sql) return { ok: false, reason: "db_not_configured" };
  if (!mailer) return { ok: false, reason: "smtp_not_configured" };

  const rows = await sql`
    SELECT id, email, unsub_token
    FROM product_watch_subscriptions
    WHERE product_id = ${product.id}
      AND active = true
      AND notified_at IS NULL
    ORDER BY created_at ASC
  `;

  if (!rows?.length) {
    return { ok: true, sent: 0 };
  }

  let sent = 0;
  for (const row of rows) {
    const to = row.email;
    const link = productUrl(product.id);
    const unsub = unsubscribeUrl(row.unsub_token);

    try {
      await mailer.sendMail({
        from: SMTP_FROM,
        to,
        subject: `Товар снова в наличии: ${product.title}`,
        text: [
          `Здравствуйте!`,
          ``,
          `Товар снова в наличии: ${product.title}`,
          `Ссылка: ${link}`,
          ``,
          `Если вы больше не хотите получать уведомления: ${unsub}`,
        ].join("\n"),
        html: `
          <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; line-height: 1.5">
            <h2 style="margin: 0 0 12px">Товар снова в наличии</h2>
            <p style="margin: 0 0 10px"><strong>${product.title}</strong></p>
            <p style="margin: 0 0 14px">
              <a href="${link}">Открыть товар на сайте</a>
            </p>
            <p style="margin: 18px 0 0; font-size: 12px; color: #6b7280">
              Не хотите получать уведомления по этому товару?
              <a href="${unsub}">Отписаться</a>
            </p>
          </div>
        `.trim(),
      });

      await sql`
        UPDATE product_watch_subscriptions
        SET notified_at = now(), active = false
        WHERE id = ${row.id}
      `;
      sent += 1;
    } catch (error) {
      console.error("Email send error:", error);
    }
  }

  return { ok: true, sent };
}

function formatTelegramMessage(payment) {
  const metadataRaw = payment?.metadata?.items ? payment.metadata.items : "[]";
  let items = [];
  try {
    items = typeof metadataRaw === "string" ? JSON.parse(metadataRaw) : metadataRaw;
  } catch (_err) {
    items = [];
  }

  const total = payment?.amount?.value ?? "—";
  const meta = payment?.metadata ?? {};

  const lines = [
    `✅ Оплачен заказ`,
    ``,
    `Имя: ${meta.fullName ?? "—"}`,
    `Телефон: ${meta.phone ?? "—"}`,
    `Доставка: ${meta.deliveryMethod ?? "—"}`,
    `Адрес: ${meta.address ?? "—"}`,
    ``,
    `Сумма: ${total} ₽`,
    `ID платежа: ${payment?.id ?? "—"}`,
    ``,
    `Товары:`,
    ...items.map((item) => `• ${item.title ?? item.id} — ${item.quantity} шт. × ${item.price} ₽`),
  ];

  return lines.join("\n");
}

function formatOrderDraftMessage(body, items) {
  const lines = [
    `📝 Новая заявка на оплату`,
    ``,
    `Имя: ${body.fullName}`,
    `Телефон: ${body.phone}`,
    `Доставка: ${body.deliveryMethod}`,
    `Адрес: ${body.address}`,
    ``,
    `Сумма: ${body.totalPrice} ₽`,
    ``,
    `Товары:`,
    ...items.map((item) => `• ${item.title} — ${item.quantity} шт. × ${item.price} ₽`),
  ];

  return lines.join("\n");
}

async function sendTelegramNotification(payment) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return;
  }

  const text = formatTelegramMessage(payment);
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      console.error("Telegram sendMessage error", response.status, data);
    }
  } catch (error) {
    console.error("Telegram notification error", error);
  }
}

async function sendTelegramDraft(body, items) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram not configured in proxy - missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    console.log("TELEGRAM_BOT_TOKEN:", TELEGRAM_BOT_TOKEN ? "✅ set" : "❌ missing");
    console.log("TELEGRAM_CHAT_ID:", TELEGRAM_CHAT_ID ? "✅ set" : "❌ missing");
    return;
  }

  const text = formatOrderDraftMessage(body, items);
  console.log("📤 Sending Telegram draft message, text length:", text.length);
  
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      console.error("❌ Telegram draft send error", response.status, data);
    } else {
      console.log("✅ Telegram draft sent successfully");
    }
  } catch (error) {
    console.error("❌ Telegram draft error", error);
  }
}

app.post("/create-payment", async (req, res) => {
  try {
    if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
      return res.status(500).json({ error: "Server is not configured for YooKassa" });
    }

    const body = req.body ?? {};

    for (const field of requiredFields) {
      if (!body[field]) {
        return res.status(400).json({ error: `Missing field: ${field}` });
      }
    }

    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ error: "Order must contain items" });
    }

    const totalPrice = Number(body.totalPrice);
    if (Number.isNaN(totalPrice) || totalPrice <= 0) {
      return res.status(400).json({ error: "Invalid totalPrice" });
    }

    const normalizedItems = body.items.map((item, index) => {
      const product = item.product ?? {};
      const quantity = Number(item.quantity) || 1;
      const unitPrice = Number(product.price) || 0;
      return {
        id: product.id ?? `item-${index + 1}`,
        title: product.title ?? `Товар ${index + 1}`,
        quantity,
        price: unitPrice,
      };
    });

    const idempotenceKey = crypto.randomUUID();
    const auth = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64");

    console.log("📝 Creating payment, sending Telegram draft...");
    await sendTelegramDraft(body, normalizedItems);

    const response = await fetch("https://api.yookassa.ru/v3/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
        "Idempotence-Key": idempotenceKey,
      },
      body: JSON.stringify({
        amount: {
          value: totalPrice.toFixed(2),
          currency: "RUB",
        },
        capture: true,
        description: `Заказ с сайта: ${body.fullName} (${body.phone})`,
        confirmation: {
          type: "redirect",
          return_url: PUBLIC_RETURN_URL,
        },
        metadata: {
          fullName: body.fullName,
          phone: body.phone,
          deliveryMethod: body.deliveryMethod,
          address: body.address,
          items: JSON.stringify(normalizedItems),
        },
        receipt: {
          customer: {
            phone: body.phone.startsWith("+") ? body.phone : `+${body.phone}`,
          },
          items: normalizedItems.map((item) => ({
            description: item.title.substring(0, 128),
            quantity: item.quantity,
            amount: {
              value: (item.price).toFixed(2),
              currency: "RUB",
            },
            vat_code: 1,
          })),
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("YooKassa error", response.status, data);
      return res.status(502).json({
        error: "Failed to create payment in YooKassa",
        details: data,
      });
    }

    return res.json({
      confirmationUrl: data?.confirmation?.confirmation_url,
      paymentId: data?.id,
      status: data?.status,
    });
  } catch (error) {
    console.error("Proxy error", error);
    return res.status(500).json({
      error: "Internal proxy error",
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// --- API товаров (Neon) для каталога и админки ---
app.get("/api/product-watch/list", async (_req, res) => {
  if (!sql) {
    return res.status(503).json({ error: "Database not configured (DATABASE_URL)" });
  }

  try {
    const rows = await sql`
      SELECT
        p.id AS product_id,
        p.title,
        array_agg(DISTINCT s.email ORDER BY s.email) AS emails,
        count(DISTINCT s.email) AS total,
        max(s.created_at) AS last_subscribed_at
      FROM product_watch_subscriptions s
      JOIN products p ON p.id = s.product_id
      WHERE s.active = true
      GROUP BY p.id, p.title
      ORDER BY p.title ASC
    `;

    const result = rows.map((row) => ({
      productId: row.product_id,
      title: row.title,
      emails: row.emails || [],
      total: Number(row.total) || 0,
      lastSubscribedAt: row.last_subscribed_at || null,
    }));

    return res.json(result);
  } catch (err) {
    console.error("Product watch list error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

app.post("/api/product-watch/subscribe", async (req, res) => {
  if (!sql) {
    return res.status(503).json({ error: "Database not configured (DATABASE_URL)" });
  }

  try {
    const productId = String(req.body?.productId ?? "").trim();
    const email = normalizeEmail(req.body?.email);

    if (!productId) {
      return res.status(400).json({ error: "Missing productId" });
    }
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }

    const [product] = await sql`SELECT id FROM products WHERE id = ${productId}`;
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const token = crypto.randomUUID();
    const [subscription] = await sql`
      INSERT INTO product_watch_subscriptions (product_id, email, unsub_token, active, notified_at)
      VALUES (${productId}, ${email}, ${token}, true, NULL)
      ON CONFLICT (product_id, email)
      DO UPDATE SET active = true, notified_at = NULL
      RETURNING id, product_id, email, active, created_at, notified_at
    `;

    return res.json({ ok: true, subscription });
  } catch (err) {
    console.error("Subscribe error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

app.get("/api/product-watch/unsubscribe/:token", async (req, res) => {
  if (!sql) {
    return res.status(503).send("Database not configured");
  }
  try {
    const token = String(req.params.token ?? "").trim();
    if (!token) return res.status(400).send("Missing token");

    const updated = await sql`
      UPDATE product_watch_subscriptions
      SET active = false
      WHERE unsub_token = ${token}
      RETURNING id
    `;

    if (!updated?.length) {
      return res.status(404).send("Subscription not found");
    }

    return res
      .status(200)
      .send(
        `<!doctype html><meta charset="utf-8"><title>Отписка</title><div style="font-family:system-ui,Segoe UI,Roboto,Arial;padding:24px">Вы отписались от уведомлений по этому товару.</div>`
      );
  } catch (err) {
    console.error("Unsubscribe error:", err);
    return res.status(500).send("Internal error");
  }
});

app.get("/api/products", async (_req, res) => {
  if (!sql) {
    return res.status(503).json({ error: "Database not configured (DATABASE_URL)" });
  }
  try {
    const rows = await sql`
      SELECT id, title, price, description, image, full_description, in_stock, category, is_glass, is_unbreakable, created_at, updated_at
      FROM products
      ORDER BY created_at DESC NULLS LAST
    `;
    const products = rows.map(rowToProduct);
    return res.json(products);
  } catch (err) {
    console.error("Products GET error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

app.post("/api/products", async (req, res) => {
  if (!sql) {
    return res.status(503).json({ error: "Database not configured (DATABASE_URL)" });
  }
  try {
    const row = bodyToRow(req.body || {});
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO products (id, title, price, description, image, full_description, in_stock, category, is_glass, is_unbreakable, updated_at)
      VALUES (${id}, ${row.title}, ${row.price}, ${row.description}, ${row.image}, ${row.full_description}, ${row.in_stock}, ${row.category}, ${row.is_glass}, ${row.is_unbreakable}, now())
    `;
    const [inserted] = await sql`
      SELECT id, title, price, description, image, full_description, in_stock, category, is_glass, is_unbreakable, created_at, updated_at
      FROM products WHERE id = ${id}
    `;
    return res.status(201).json(rowToProduct(inserted));
  } catch (err) {
    console.error("Products POST error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

app.get("/api/products/:id", async (req, res) => {
  if (!sql) {
    return res.status(503).json({ error: "Database not configured (DATABASE_URL)" });
  }
  try {
    const { id } = req.params;
    const rows = await sql`
      SELECT id, title, price, description, image, full_description, in_stock, category, is_glass, is_unbreakable, created_at, updated_at
      FROM products WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Product not found" });
    return res.json(rowToProduct(row));
  } catch (err) {
    console.error("Product GET error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

app.patch("/api/products/:id", async (req, res) => {
  if (!sql) {
    return res.status(503).json({ error: "Database not configured (DATABASE_URL)" });
  }
  try {
    const { id } = req.params;
    const [existing] = await sql`
      SELECT id, title, price, description, image, full_description, in_stock, category, is_glass, is_unbreakable, created_at, updated_at
      FROM products WHERE id = ${id}
    `;
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const currentBody = {
      title: existing.title,
      price: existing.price,
      description: existing.description,
      image: existing.image,
      fullDescription: existing.full_description ?? "",
      inStock: existing.in_stock,
      category: existing.category ?? "",
      isGlass: existing.is_glass ?? false,
      isUnbreakable: existing.is_unbreakable ?? false,
    };
    const row = bodyToRow({ ...currentBody, ...(req.body || {}) });
    await sql`
      UPDATE products SET
        title = ${row.title},
        price = ${row.price},
        description = ${row.description},
        image = ${row.image},
        full_description = ${row.full_description},
        in_stock = ${row.in_stock},
        category = ${row.category},
        is_glass = ${row.is_glass},
        is_unbreakable = ${row.is_unbreakable},
        updated_at = now()
      WHERE id = ${id}
    `;
    const [updated] = await sql`
      SELECT id, title, price, description, image, full_description, in_stock, category, is_glass, is_unbreakable, created_at, updated_at
      FROM products WHERE id = ${id}
    `;

    // Авто-уведомления: если было "нет в наличии", а стало "в наличии"
    if (existing.in_stock === false && updated?.in_stock === true) {
      notifyWatchersInStock({ id: updated.id, title: updated.title }).catch((err) => {
        console.error("notifyWatchersInStock error:", err);
      });
    }

    return res.json(rowToProduct(updated));
  } catch (err) {
    console.error("Product PATCH error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  if (!sql) {
    return res.status(503).json({ error: "Database not configured (DATABASE_URL)" });
  }
  try {
    const { id } = req.params;
    const deleted = await sql`DELETE FROM products WHERE id = ${id} RETURNING id`;
    if (!deleted?.length) return res.status(404).json({ error: "Product not found" });
    return res.status(204).end();
  } catch (err) {
    console.error("Product DELETE error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

app.post("/yookassa-webhook", async (req, res) => {
  if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
    return res.status(500).json({ error: "Server is not configured for YooKassa" });
  }

  const authHeader = req.headers["authorization"];
  if (authHeader !== expectedWebhookAuth) {
    console.warn("Invalid webhook auth header");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const event = req.body?.event;
  const payment = req.body?.object;

  if (event === "payment.succeeded" && payment) {
    await sendTelegramNotification(payment);
  }

  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ YooKassa proxy server is running on port ${PORT}`);
  console.log(`🌐 Accessible at http://localhost:${PORT} or http://<your-local-ip>:${PORT}`);
});

