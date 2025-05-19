import express from "express";
import admin from "firebase-admin";
import Stripe from "stripe";
import bodyParser from "body-parser";
import fs from "fs";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";


const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Firebase Admin Init
const serviceAccount = JSON.parse(fs.readFileSync("./firebase-key.json", "utf8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();

// CORS options
const corsOptions = {
  origin: [
    "https://rankwager.com",
    "https://api.rankwager.com",
    "https://www.api.rankwager.com"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

// Preflight OPTIONS requests handling
app.options("*", cors(corsOptions));

// Apply CORS globally for all routes except webhook
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    next();
  } else {
    cors(corsOptions)(req, res, next);
  }
});

// Only skip JSON body parsing for webhook route
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Stripe webhook (must use raw body parser)

app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
  const session = event.data.object;
  const name = session.metadata?.name || "Anonymous";
  const amount = session.amount_total;
  const timestamp = Date.now();

  const paymentId = session.metadata?.paymentId || uuidv4(); // ✅ This is correct

  const entry = {
    id: paymentId,
    name,
    total: amount,
    timestamp,
  };

  try {
    await db.ref(`payments/${paymentId}`).set(entry); // ✅ Using paymentId as key
    console.log(`✅ Stored payment: ${name} - $${(amount / 100).toFixed(2)}`);
  } catch (error) {
    console.error("❌ Firebase write error:", error.message);
  }
}

  res.json({ received: true });
});


// Stripe Checkout session route
app.post("/create-checkout-session", async (req, res) => {
  const { name, amount } = req.body;
  const paymentId = uuidv4();

  if (!name || !amount) {
    return res.status(400).json({ error: "Name and amount are required" });
  }

  const amountInCents = Math.round(parseFloat(amount) * 100);

  if (isNaN(amountInCents) || amountInCents < 50) {
    return res.status(400).json({ error: "Amount must be a valid number and at least $0.50" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Leaderboard Donation",
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `https://rankwager.com?success=true&id=${paymentId}`,
      cancel_url: "https://rankwager.com?canceled=true",
      metadata: { name, paymentId },
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error("Stripe session error:", error.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});


app.get("/payments/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const snapshot = await db.ref(`payments/${id}`).once("value");
    const data = snapshot.val();

    if (!data) return res.status(404).json({ error: "Payment not found" });

    res.json(data);
  } catch (error) {
    console.error("Payment fetch error:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});



// Leaderboard data
app.get("/leaderboard", async (req, res) => {
  try {
    const snapshot = await db.ref("payments").once("value");
    const data = snapshot.val();
    console.log("Raw payments data from DB:", data);

    if (!data) {
      console.log("No leaderboard data found.");
      return res.json([]);
    }

    // Step 1: Aggregate totals per user
    const aggregated = {};

    for (const key in data) {
      const entry = data[key];
      if (!entry.name || !entry.total) continue;

      if (!aggregated[entry.name]) {
        aggregated[entry.name] = 0;
      }

      aggregated[entry.name] += entry.total;
    }

    // Step 2: Sort by total descending
    const leaderboard = Object.entries(aggregated)
      .map(([name, total]) => ({
        name,
        score: (total / 100).toFixed(2), // Convert cents to dollars
      }))
      .sort((a, b) => b.score - a.score);

    // Step 3: Add ranks
    const ranked = leaderboard.map((entry, index) => ({
      rank: index + 1,
      ...entry,
    }));

    console.log("Final leaderboard:", ranked);
    res.json(ranked);
  } catch (error) {
    console.error("Leaderboard fetch error:", error);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});



app.get("/", (req, res) => res.send("Stripe Webhook Server Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
