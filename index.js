const express = require("express");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const bodyParser = require("body-parser");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Firebase Admin Init
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DB_URL
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
      total: amount
    });

    console.log(`Logged payment from ${name}: $${(amount / 100).toFixed(2)}`);
  }

  res.json({ received: true });
});

app.get("/", (req, res) => res.send("Stripe Webhook Server Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
