// bot.js
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const db = new Database("./db.sqlite");

// Config
const TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0); // ton chat id pour notifier commandes
if (!TOKEN || !ADMIN_CHAT_ID) {
  console.error("Définis TELEGRAM_TOKEN et ADMIN_CHAT_ID dans .env");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// === DB init ===
db.prepare(
  `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  unit_price REAL,
  unit TEXT,
  stock INTEGER,
  description TEXT
)`
).run();

db.prepare(
  `
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  name TEXT,
  telegram_username TEXT,
  phone TEXT
)`
).run();

db.prepare(
  `
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  status TEXT,
  total REAL,
  delivery_type TEXT,
  address TEXT,
  phone TEXT,
  created_at TEXT
)`
).run();

db.prepare(
  `
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  product_id INTEGER,
  quantity REAL,
  unit_price REAL
)`
).run();

// === Helper queries ===
const getProducts = () => db.prepare("SELECT * FROM products").all();
const getProduct = (id) =>
  db.prepare("SELECT * FROM products WHERE id = ?").get(id);
const createOrder = (user_id, total, delivery_type, address, phone) => {
  const now = new Date().toISOString();
  const r = db
    .prepare(
      "INSERT INTO orders (user_id, status, total, delivery_type, address, phone, created_at) VALUES (?,?,?,?,?,?,?)"
    )
    .run(user_id, "NEW", total, delivery_type, address, phone, now);
  return r.lastInsertRowid;
};
const addItem = (order_id, product_id, quantity, unit_price) => {
  db.prepare(
    "INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?,?,?,?)"
  ).run(order_id, product_id, quantity, unit_price);
};
const getOrder = (order_id) =>
  db.prepare("SELECT * FROM orders WHERE id = ?").get(order_id);
const getOrderItems = (order_id) =>
  db
    .prepare(
      "SELECT oi.*, p.name, p.unit FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?"
    )
    .all(order_id);

// === In-memory cart per user (simple) ===
const carts = {}; // { userId: { items: [{productId, quantity}], deliveryType, address, phone } }

// === Admin commands ===
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || "Client";
  bot.sendMessage(
    chatId,
    `Bonjour ${firstName} 👷‍♂️\nBienvenue sur *Matériaux Mada Bot*.\n\nChoisissez une option:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [
          ["🧱 Voir les produits", "🛒 Voir mon panier"],
          ["📦 Passer commande", "📞 Contact / Support"],
        ],
        resize_keyboard: true,
      },
    }
  );
  // store user
  db.prepare(
    "INSERT OR IGNORE INTO users (user_id, name, telegram_username) VALUES (?,?,?)"
  ).run(
    msg.from.id,
    `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim(),
    msg.from.username || ""
  );
});

// Command: Voir les produits
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (text === "🧱 Voir les produits") {
    const prods = getProducts();
    if (!prods.length) {
      return bot.sendMessage(
        chatId,
        "Aucun produit trouvé. L'admin doit ajouter des produits via la base."
      );
    }
    const buttons = prods.map((p) => [
      {
        text: `${p.name} — ${p.unit_price} Ar / ${p.unit}`,
        callback_data: `p_${p.id}`,
      },
    ]);
    return bot.sendMessage(chatId, "Nos produits :", {
      reply_markup: {
        inline_keyboard: buttons,
      },
    });
  }

  if (text === "🛒 Voir mon panier") {
    const cart = carts[chatId];
    if (!cart || !cart.items || cart.items.length === 0)
      return bot.sendMessage(chatId, "Ton panier est vide.");
    let msgText = "*Ton panier:*\n";
    let total = 0;
    for (const it of cart.items) {
      const p = getProduct(it.productId);
      const subtotal = p.unit_price * it.quantity;
      total += subtotal;
      msgText += `- ${p.name}: ${it.quantity} ${p.unit} x ${p.unit_price} Ar = ${subtotal} Ar\n`;
    }
    msgText += `\n*Total:* ${total} Ar\n`;
    bot.sendMessage(chatId, msgText, {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [
          ["➕ Ajouter produit", "🗑️ Vider panier"],
          ["📦 Passer commande", "↩️ Retour"],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (text === "➕ Ajouter produit") {
    // show products similarly
    const prods = getProducts();
    const buttons = prods.map((p) => [
      {
        text: `${p.name} — ${p.unit_price} Ar / ${p.unit}`,
        callback_data: `p_${p.id}`,
      },
    ]);
    return bot.sendMessage(chatId, "Choisis un produit à ajouter :", {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  if (text === "🗑️ Vider panier") {
    delete carts[chatId];
    return bot.sendMessage(chatId, "Panier vidé.");
  }

  if (text === "📦 Passer commande") {
    const cart = carts[chatId];
    if (!cart || !cart.items || cart.items.length === 0)
      return bot.sendMessage(chatId, "Ton panier est vide.");
    // ask delivery type
    bot.sendMessage(chatId, "Choisis le type de livraison :", {
      reply_markup: {
        keyboard: [
          ["Standard (2–4 jours) — 0 Ar"],
          ["Express (24–48h) — 20000 Ar"],
          ["↩️ Retour"],
        ],
        resize_keyboard: true,
      },
    });
    cart.waiting = "delivery_type";
    return;
  }

  if (
    text === "Standard (2–4 jours) — 0 Ar" ||
    text === "Express (24–48h) — 20000 Ar"
  ) {
    const cart = carts[chatId];
    if (!cart || !cart.items || cart.items.length === 0)
      return bot.sendMessage(chatId, "Ton panier est vide.");
    cart.deliveryType = text.includes("Express") ? "EXPRESS" : "STANDARD";
    // ask address
    cart.waiting = "address";
    return bot.sendMessage(
      chatId,
      "Envoie ton adresse de livraison complète (quartier, rue, point de repère) :"
    );
  }

  if (carts[chatId] && carts[chatId].waiting === "address") {
    carts[chatId].address = text;
    carts[chatId].waiting = "phone";
    return bot.sendMessage(
      chatId,
      "Indique ton numéro de téléphone (ex: 034...) :"
    );
  }

  if (carts[chatId] && carts[chatId].waiting === "phone") {
    carts[chatId].phone = text;
    // compute total and confirm
    const cart = carts[chatId];
    let total = 0;
    for (const it of cart.items) {
      const p = getProduct(it.productId);
      total += p.unit_price * it.quantity;
    }
    if (cart.deliveryType === "EXPRESS") total += 20000;
    cart.total = total;
    // Show summary and ask confirm
    let summary = "*Récapitulatif de commande:*\n";
    for (const it of cart.items) {
      const p = getProduct(it.productId);
      summary += `- ${p.name}: ${it.quantity} ${p.unit} x ${p.unit_price} = ${
        p.unit_price * it.quantity
      } Ar\n`;
    }
    summary += `\nLivraison: ${cart.deliveryType}\nAdresse: ${cart.address}\nTéléphone: ${cart.phone}\n*Total à payer:* ${cart.total} Ar\n\nConfirmer la commande ?`;
    bot.sendMessage(chatId, summary, {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [["✅ Confirmer"], ["❌ Annuler"]],
        resize_keyboard: true,
      },
    });
    cart.waiting = "confirm";
    return;
  }

  if (text === "✅ Confirmer") {
    const cart = carts[chatId];
    if (!cart || cart.waiting !== "confirm")
      return bot.sendMessage(chatId, "Aucune commande à confirmer.");
    // create order
    const orderId = createOrder(
      chatId,
      cart.total,
      cart.deliveryType,
      cart.address,
      cart.phone
    );
    for (const it of cart.items) {
      const p = getProduct(it.productId);
      addItem(orderId, it.productId, it.quantity, p.unit_price);
    }
    // notify admin
    const order = getOrder(orderId);
    const items = getOrderItems(orderId);
    let adminMsg = `📥 *Nouvelle commande* #${orderId}\nClient: ${
      msg.from.first_name || ""
    } ${msg.from.last_name || ""} (@${msg.from.username || "—"})\nTel: ${
      cart.phone
    }\nAdresse: ${cart.address}\nLivraison: ${order.delivery_type}\nTotal: ${
      order.total
    } Ar\n\nItems:\n`;
    for (const it of items) {
      adminMsg += `- ${it.name}: ${it.quantity} ${it.unit} x ${
        it.unit_price
      } = ${it.quantity * it.unit_price} Ar\n`;
    }
    bot.sendMessage(ADMIN_CHAT_ID, adminMsg, { parse_mode: "Markdown" });
    bot.sendMessage(
      chatId,
      `✅ Ta commande #${orderId} a été reçue. Nous te contacterons pour confirmer la livraison.`,
      { reply_markup: { remove_keyboard: true } }
    );
    // clear cart
    delete carts[chatId];
    return;
  }

  if (text === "❌ Annuler") {
    delete carts[chatId];
    return bot.sendMessage(chatId, "Commande annulée et panier vidé.", {
      reply_markup: { remove_keyboard: true },
    });
  }

  if (text === "📞 Contact / Support") {
    return bot.sendMessage(
      chatId,
      "Contact support: +261 34 XX XX XX (ou écris ici) — Nous répondons en heures ouvrables."
    );
  }

  // fallback
  // if message is a number after selecting a product, handle inline flow below (see callback query)
});

// === Inline buttons product selection ===
bot.on("callback_query", (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data; // e.g. p_1
  if (!data) return;
  if (data.startsWith("p_")) {
    const id = Number(data.split("_")[1]);
    const p = getProduct(id);
    if (!p) return bot.sendMessage(chatId, "Produit introuvable.");
    // Ask quantity
    bot.sendMessage(
      chatId,
      `Produit: *${p.name}* — ${p.unit_price} Ar / ${p.unit}\nDescription: ${
        p.description || "-"
      }\nStock: ${
        p.stock || "∞"
      }\n\nIndique la quantité que tu veux (ex: 10 pour 10 unités / 0.5 pour 0.5 m3) :`,
      { parse_mode: "Markdown" }
    );
    // store awaiting quantity
    carts[chatId] = carts[chatId] || { items: [] };
    carts[chatId].waitingForProduct = id;
  }
  bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
});

// === capture quantity messages when waitingForProduct ===
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const cart = carts[chatId];
  if (!cart || !cart.waitingForProduct) return;
  const q = parseFloat(msg.text.replace(",", "."));
  if (isNaN(q) || q <= 0) {
    bot.sendMessage(
      chatId,
      "Quantité invalide. Envoie un nombre (ex: 10 ou 0.5)."
    );
    return;
  }
  const pid = cart.waitingForProduct;
  const p = getProduct(pid);
  cart.items.push({ productId: pid, quantity: q });
  delete cart.waitingForProduct;
  bot.sendMessage(chatId, `${p.name} x ${q} ajouté au panier.`, {
    reply_markup: {
      keyboard: [
        ["🧱 Voir les produits", "🛒 Voir mon panier"],
        ["📦 Passer commande", "📞 Contact / Support"],
      ],
      resize_keyboard: true,
    },
  });
});

// === Admin commands via Telegram chat with bot ===
// /list_orders - liste commandes récentes
bot.onText(/\/list_orders/, (msg) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const orders = db
    .prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 50")
    .all();
  if (!orders.length) return bot.sendMessage(msg.chat.id, "Aucune commande.");
  let text = "*Commandes récentes:*\n";
  for (const o of orders) {
    text += `#${o.id} — ${o.status} — ${o.total} Ar — ${o.created_at}\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// /view_order <id>
bot.onText(/\/view_order (\d+)/, (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const id = Number(match[1]);
  const o = getOrder(id);
  if (!o) return bot.sendMessage(msg.chat.id, "Commande introuvable.");
  const items = getOrderItems(id);
  let text = `*Commande #${id}*\nStatus: ${o.status}\nTotal: ${o.total} Ar\nAdresse: ${o.address}\nTel: ${o.phone}\nItems:\n`;
  for (const it of items)
    text += `- ${it.name}: ${it.quantity} ${it.unit} x ${it.unit_price} = ${
      it.quantity * it.unit_price
    } Ar\n`;
  text += `\nUtilise /set_status ${id} STATUS (EN_COURS|LIVRÉ|ANNULÉ)`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// /set_status <id> <status>
bot.onText(/\/set_status (\d+) (\w+)/, (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const id = Number(match[1]);
  const status = match[2].toUpperCase();
  db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, id);
  bot.sendMessage(msg.chat.id, `Commande #${id} mise à jour: ${status}`);
  // notify user
  const o = getOrder(id);
  bot.sendMessage(o.user_id, `Votre commande #${id} est maintenant: ${status}`);
});

// === small helper to seed sample products (run once) ===
function seedProducts() {
  const count = db.prepare("SELECT COUNT(*) as c FROM products").get().c;
  if (count > 0) return;
  const seed = [
    {
      name: "Brique pleine",
      unit_price: 800,
      unit: "pièce",
      stock: 10000,
      description: "Brique standard 20x10x5",
    },
    {
      name: "Moellon",
      unit_price: 1200,
      unit: "pièce",
      stock: 5000,
      description: "Moellon pour mur",
    },
    {
      name: "Gravillon (m3)",
      unit_price: 350000,
      unit: "m3",
      stock: 200,
      description: "Gravillon 0-10mm",
    },
    {
      name: "Fer Ø10 (par bar)",
      unit_price: 15000,
      unit: "barre",
      stock: 1000,
      description: "Fer rond Ø10, 6m",
    },
    {
      name: "Ciment (sac 50kg)",
      unit_price: 25000,
      unit: "sac",
      stock: 2000,
      description: "Ciment OPC 50kg",
    },
  ];
  const stmt = db.prepare(
    "INSERT INTO products (name, unit_price, unit, stock, description) VALUES (?,?,?,?,?)"
  );
  for (const p of seed)
    stmt.run(p.name, p.unit_price, p.unit, p.stock, p.description);
  console.log("Produits initialisés");
}
seedProducts();

console.log("Bot started");
