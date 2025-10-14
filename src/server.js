import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { generateText } from "./openaiclient.js";
import { outboundSMSPrompt } from "./prompts.js";
import { upsertLead, listLeads, setLeadStatus } from "./memoryStore.js";
import { sendSMS, handleIncomingSMS } from "./twilioHandlers.js";
import http from "http";
import { initRealtimeServer } from "./realtimeserver.js"; // Groß-/Kleinschreibung korrigiert

dotenv.config();

const app = express();

// Twilio sendet x-www-form-urlencoded bei Webhooks
app.use("/webhooks/sms", bodyParser.urlencoded({ extended: false }));
// JSON für unsere eigenen APIs
app.use(bodyParser.json());

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * 1) Neuer Lead → sofort SMS
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
 * 2) Twilio Webhook: eingehende Antworten (SMS)
 */
app.post("/webhooks/sms", handleIncomingSMS);

/**
 * 3) Einfache Übersicht (MVP)
 */
app.get("/api/leads", (_req, res) => {
  res.json({ leads: listLeads() });
});

/**
 * 4) Twilio Voice Webhook → startet Realtime Stream
 */
app.post("/webhooks/voice", (req, res) => {
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${process.env.BASE_URL.replace(/^https?:\/\//, "")}/realtime" />
      </Connect>
    </Response>`;
  res.type("text/xml").send(twiml);
});

// === Server starten + Realtime-Server initialisieren ===
const server = http.createServer(app);
initRealtimeServer(server);
server.listen(process.env.PORT || 10000, () =>
  console.log(`✅ Timbra AI läuft auf Port ${process.env.PORT || 10000}`)
);

