import express from "express";
import admin from "firebase-admin";
import Stripe from "stripe";
import bodyParser from "body-parser"; 
import fs from "fs";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";

const app = express();

// General rate limiter for all routes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please try again later.",
  },
});

// Stricter rate limiter for donations
const donationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many donation attempts. Please try again in an hour.",
  },
});

app.use(generalLimiter); // Apply general limiter globally


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

// Helper: assign tier based on total amount donated (in dollars)
function getTier(amount) {
  if (amount >= 200) return "Whale";
  if (amount >= 50) return "Shark";
  if (amount >= 1) return "Shrimp";
  return "Unknown";
}

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

    // Convert cents to dollars here
    const amountInDollars = session.amount_total / 100;

    const paymentId = session.metadata?.paymentId || uuidv4();

    const entry = {
      id: paymentId,
      name,
      total: amountInDollars,  // store dollars directly
      timestamp: Date.now(),
    };

    try {
      await db.ref(`payments/${paymentId}`).set(entry);
      console.log(`✅ Stored payment: ${name} - $${amountInDollars.toFixed(2)}`);
    } catch (error) {
      console.error("❌ Firebase write error:", error.message);
    }
  }

  res.json({ received: true });
});

// Stripe Checkout session route
app.post("/create-checkout-session", donationLimiter, async (req, res) => {
  const { name, amount, token } = req.body;
  const paymentId = uuidv4();

  if (!name || !amount || !token) {
    return res.status(400).json({ error: "Name, amount, and reCAPTCHA token are required" });
  }

  // Verify reCAPTCHA token with Google
  try {
    const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        secret: process.env.RECAPTCHA_SECRET_KEY,
        response: token,
      }),
    });

    const data = await response.json();

    if (!data.success || (data.score !== undefined && data.score < 0.5)) {
      return res.status(403).json({ error: "reCAPTCHA verification failed" });
    }
  } catch (error) {
    console.error("reCAPTCHA verification error:", error.message);
    return res.status(500).json({ error: "Failed to verify reCAPTCHA" });
  }

  // Validate and convert amount
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
            product_data: { name: "Leaderboard Donation" },
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
  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});


// Get single payment by id
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
    res.setHeader("Cache-Control", "public, max-age=15");
    const snapshot = await db.ref("payments").once("value");
    const data = snapshot.val();

    if (!data) {
      return res.json([]);
    }

    // Aggregate totals per user in dollars
    const aggregated = {};

    for (const key in data) {
      const entry = data[key];
      if (!entry.name || !entry.total) continue;

      if (!aggregated[entry.name]) {
        aggregated[entry.name] = 0;
      }

      aggregated[entry.name] += entry.total; // total already in dollars
    }

    // Sort descending by total
    const leaderboard = Object.entries(aggregated)
      .map(([name, total]) => ({
        name,
        score: total.toFixed(2),
      }))
      .sort((a, b) => parseFloat(b.score) - parseFloat(a.score));

    // Add ranks and tier
    const ranked = leaderboard.map((entry, index) => ({
      rank: index + 1,
      ...entry,
      tier: getTier(parseFloat(entry.score)),
    }));
    await db.ref("leaderboard").set(ranked);
    
    res.json(ranked);
  } catch (error) {
    console.error("Leaderboard fetch error:", error);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

app.get("/stats", async (req, res) => {
  try {
    const snapshot = await db.ref("payments").once("value");
    const data = snapshot.val();

    if (!data) {
      return res.json({
        shrimpCount: 0,
        sharkCount: 0,
        whaleCount: 0,
        totalMatches: 0,
      });
    }

    let shrimpCount = 0;
    let sharkCount = 0;
    let whaleCount = 0;

    for (const key in data) {
      const entry = data[key];
      if (!entry.total) continue;

      const tier = getTier(entry.total / 100);

      if (tier === "Whale") whaleCount++;
      else if (tier === "Shark") sharkCount++;
      else if (tier === "Shrimp") shrimpCount++;
    }

    const totalMatches = Object.keys(data).length;

    res.json({
      shrimpCount,
      sharkCount,
      whaleCount,
      totalMatches,
    });
  } catch (error) {
    console.error("Stats fetch error:", error.message);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});


app.get("/", (req, res) => res.send("Stripe Webhook Server Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
