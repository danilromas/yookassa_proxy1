import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8787;

const {
  YOOKASSA_SHOP_ID,
  YOOKASSA_SECRET_KEY,
  PUBLIC_RETURN_URL = "http://localhost:5173/#/payment-result",
  ALLOWED_ORIGINS = "*",
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
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

app.listen(PORT, () => {
  console.log(`✅ YooKassa proxy server is running on port ${PORT}`);
});

