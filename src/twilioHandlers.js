import twilio from "twilio";
import { generateText } from "./openaiClient.js";
import { inboundParsePrompt, followupConfirmSMS, followupAskTimeSMS, followupDeclineSMS } from "./prompts.js";
import { getLeadByPhone, setLeadStatus } from "./memoryStore.js";
import { createCalendarEvent } from "./calendar.js";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_PHONE;

/**
 * Sendet eine SMS
 */
export async function sendSMS(to, body) {
  return client.messages.create({ from: FROM, to, body });
}

/**
 * Webhook-Handler für eingehende Antworten (Twilio SMS)
 * Erwartet application/x-www-form-urlencoded
 */
export async function handleIncomingSMS(req, res) {
  try {
    const incomingText = (req.body.Body || "").trim();
    const from = (req.body.From || "").trim();

    const lead = getLeadByPhone(from);
    const name = lead?.name || "dir";
    const service = lead?.service || "unserem Angebot";

    // 1) Intent erkennen
    const parsed = await generateText(inboundParsePrompt(incomingText));
    let data = { intent: "unclear", datetime_text: null, notes: "" };

    try {
      data = JSON.parse(parsed);
    } catch (e) {
      // Fallback: bleibt "unclear"
    }

    // 2) Branching
    if (data.intent === "decline") {
      const msg = await generateText(followupDeclineSMS({ name }));
      await sendSMS(from, msg);
      setLeadStatus(from, "declined", { lastMsg: msg });
      return res.type("text/xml").send("<Response></Response>");
    }

    if (data.intent === "confirm" || data.intent === "time_suggestion") {
      // Versuche Datum zu interpretieren (sehr vereinfachtes MVP)
      // Wenn keine Zeit erkannt, frage nach Zeiten
      if (!data.datetime_text) {
        const ask = await generateText(followupAskTimeSMS({ name }));
        await sendSMS(from, ask);
        setLeadStatus(from, "awaiting_time", { lastMsg: ask });
        return res.type("text/xml").send("<Response></Response>");
      }

      // Naiver Versuch: datetime_text direkt verwenden
      // In echt: Parser bauen oder nächste KI-Stufe nutzen.
      const startISO = new Date(data.datetime_text).toString() === "Invalid Date"
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // fallback: +1 Tag
        : new Date(data.datetime_text).toISOString();

      // 3) Calendar Event erstellen
      const summary = `Kennenlern-Call mit ${lead?.name || "Lead"}`;
      const description = `Service: ${service}\nTelefon: ${from}\nNotizen: ${data.notes || ""}`;

      await createCalendarEvent({
        summary,
        description,
        attendees: [], // Optional: Founder-Email als Attendee hinzufügen
        startISO: startISO
      });

      const confirm = await generateText(followupConfirmSMS({ name }));
      await sendSMS(from, confirm);
      setLeadStatus(from, "booked", { when: startISO, lastMsg: confirm });
      return res.type("text/xml").send("<Response></Response>");
    }

    // Unklar → nachfragen
    const ask = await generateText(followupAskTimeSMS({ name }));
    await sendSMS(from, ask);
    setLeadStatus(from, "clarify_time", { lastMsg: ask });
    return res.type("text/xml").send("<Response></Response>");
  } catch (err) {
    console.error("Incoming SMS error:", err);
    return res.type("text/xml").send("<Response></Response>");
  }
}
