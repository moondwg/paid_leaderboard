import express from "express";
import admin from "firebase-admin";
import Stripe from "stripe";
import bodyParser from "body-parser";
import fs from "fs";

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// ✅ Load your Firebase key
const serviceAccount = JSON.parse(
  fs.readFileSync("./firebase-key.json", "utf8").replace(/\\n/g, '\n')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();
