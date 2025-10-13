import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { generateText } from "./openaiclient.js";
import { outboundSMSPrompt } from "./prompts.js";
import { upsertLead, listLeads, setLeadStatus } from "./memoryStore.js";
import { sendSMS, handleIncomingSMS } from "./twilioHandlers.js";

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
    if (!name || !phone) return res.status(400).json({ error: "name und phone sind Pflicht" });

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
 * 2) Twilio Webhook: eingehende Antworten
 */
app.post("/webhooks/sms", handleIncomingSMS);

/**
 * 3) Einfache Übersicht (MVP)
 */
app.get("/api/leads", (_req, res) => {
  res.json({ leads: listLeads() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Atlas MVP running on :${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});

