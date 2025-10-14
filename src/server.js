import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { generateText } from "./openaiClient.js"; // Beachte: Groß-/Kleinschreibung korrekt
import { outboundSMSPrompt } from "./prompts.js";
import { upsertLead, listLeads, setLeadStatus } from "./memoryStore.js";
import { sendSMS, handleIncomingSMS } from "./twilioHandlers.js";
import http from "http";
import { initRealtimeServer } from "./realtimeserver.js";
import tokenRoute from "./tokenRoute.js"; // Deine neue Token-Route

dotenv.config(); // <== .env zuerst laden

const app = express(); // <== app erst hier initialisieren!

// Middleware
app.use("/webhooks/sms", bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Token-Route aktivieren
app.use("/", tokenRoute);

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * 1️⃣ Neuer Lead → sofort SMS
 */
app.post("/api/new-lead", async (req, res) => {
  try {
    const { name, phone, service = "Beratung" } = req.body || {};
    if (!name || !phone)
      return res.status(400).json({ error: "name und phone sind Pflicht" });

    const lead = upsertLead({ name, phone, service });

    const smsText = await generateText(outboundSMSPrompt({ name, service }));
    await sendSMS(phone, smsText);

    setLeadStatus(phone, "contacted", { lastMsg: smsText });

    return res.json({ success: true, lead, sent: smsText });
  } catch (err) {
    console.error("new-lead error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

/**
 * 2️⃣ Twilio Webhook: eingehende Antworten
 */
app.post("/webhooks/sms", handleIncomingSMS);

/**
 * 3️⃣ Übersicht aller Leads (MVP)
 */
app.get("/api/leads", (_req, res) => {
  res.json({ leads: listLeads() });
});

// HTTP-Server starten
const server = http.createServer(app);
initRealtimeServer(server);

server.listen(process.env.PORT || 10000, () =>
  console.log(`✅ Timbra AI läuft auf Port ${process.env.PORT || 10000}`)
);
