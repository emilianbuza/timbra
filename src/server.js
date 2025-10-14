import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";

import { generateText } from "./openaiclient.js";
import { outboundSMSPrompt } from "./prompts.js";
import { upsertLead, listLeads, setLeadStatus } from "./memoryStore.js";
import { sendSMS, handleIncomingSMS } from "./twilioHandlers.js";
import { initRealtimeServer } from "./realtimeserver-groq.js";
import tokenRoute from "./tokenRoute.js";

dotenv.config();

// === Express Setup ===
const app = express();

// Global aktivieren: Twilio sendet x-www-form-urlencoded!
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// === Token-Route (Twilio Capability Token für Browser-Client) ===
app.use("/", tokenRoute);

// === Healthcheck ===
app.get("/health", (_req, res) => res.json({ ok: true }));

// === Lead-API: Neuer Kontakt -> SMS senden ===
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
    console.error("❌ new-lead error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// === Eingehende SMS (Twilio Webhook) ===
app.post("/webhooks/sms", handleIncomingSMS);

// === Übersicht aller Leads ===
app.get("/api/leads", (_req, res) => res.json({ leads: listLeads() }));

// === Twilio Voice Webhook (eingehender Anruf) ===
app.post("/webhooks/voice", (req, res) => {
  console.log("📞 Eingehender Anruf:", req.body.From || "unbekannt");
  console.log("🔍 CallSid:", req.body.CallSid);
  console.log("🔍 Body Keys:", Object.keys(req.body).join(", "));

  const baseUrl =
    process.env.BASE_URL?.replace(/^https?:\/\//, "") ||
    "timbra-ai.onrender.com";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${baseUrl}/media-stream" />
  </Connect>
</Response>`;

  console.log("📤 TwiML:", twiml);
  res.status(200).type("text/xml").send(twiml);
  console.log("✅ Response sent");
});

// === client.html ausliefern (Test-Frontend für Browser-Calls) ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "client.html"));
});

// === HTTP Server + Realtime-Server initialisieren ===
const server = http.createServer(app);
initRealtimeServer(server);

server.listen(process.env.PORT || 10000, () => {
  console.log(`✅ Timbra AI läuft auf Port ${process.env.PORT || 10000}`);
  console.log("🎧 Warte auf Twilio-Voice-Streams unter /media-stream");
});
