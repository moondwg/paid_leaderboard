import express from "express";
import admin from "firebase-admin";
import Stripe from "stripe";
import bodyParser from "body-parser";
import fs from "fs";
import cors from "cors";

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

app.use(cors({
  origin: "https://rankwager.com" // <--- ADD THIS
}));

// Parse webhook raw body
app.post("/webhook", bodyParser.raw({ type: "application/json" }), (req, res) => {
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

    db.ref(`payments/${name}`).set({
      name,
      total: amount,
    });

    console.log(`Logged payment from ${name}: $${(amount / 100).toFixed(2)}`);
  }

  res.json({ received: true });
});


// Step 3: Create Stripe Checkout Session
app.post("/create-checkout-session", async (req, res) => {
  const { name, amount } = req.body;

  if (!name || !amount) {
    return res.status(400).json({ error: "Name and amount are required" });
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
            unit_amount: amount, // in cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "https://rankwager.com?success=true",
      cancel_url: "https://rankwager.com?canceled=true",
      metadata: { name },
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error("Stripe session error:", error.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

app.get("/leaderboard", async (req, res) => {
  try {
    const snapshot = await db.ref("payments").once("value");
    const data = snapshot.val();

    if (!data) return res.json([]);

    // Convert to array and sort by total descending
    const leaderboard = Object.values(data)
      .sort((a, b) => b.total - a.total)
      .map(entry => ({
        name: entry.name,
        score: (entry.total / 100).toFixed(2), // Convert cents to dollars
      }));

    res.json(leaderboard);
  } catch (error) {
    console.error("Leaderboard fetch error:", error);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

app.get("/", (req, res) => res.send("Stripe Webhook Server Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
