import express from "express";
import admin from "firebase-admin";
import Stripe from "stripe";
import bodyParser from "body-parser";
import fs from "fs";

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

app.get("/", (req, res) => res.send("Stripe Webhook Server Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
