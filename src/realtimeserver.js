import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createCalendarEvent } from "./calendar.js";
dotenv.config();

const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Realtime-Server: verbindet Twilio Voice Streams mit OpenAI GPT-4 Realtime.
 *  - Hört auf /media-stream
 *  - Versteht Audio (deutsch)
 *  - Spricht mit natürlicher Stimme zurück
 *  - Kann automatisch Termine im Kalender anlegen
 */
export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/media-stream" });
  console.log("🎧 Realtime-Server wartet auf Twilio-Streams...");

  wss.on("connection", async (ws) => {
    console.log("📞 Neuer Twilio-Stream verbunden");

    // === Verbindung zur OpenAI Realtime-API herstellen ===
    const openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    // === Wenn Realtime-Session aktiv ist ===
    openaiWs.on("open", () => {
      console.log("🧠 Verbunden mit OpenAI Realtime API");

      // Konfiguration der Stimme und Systemrolle
      openaiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `
              Du bist die freundliche, empathische Praxisassistenz der Praxis Dr. Emilian Buza.
              Sprich natürlich, ruhig und mit leichtem Lächeln in der Stimme.
              Begrüße Anrufer mit einem kurzen, herzlichen Satz.
              Beispiel: "Guten Tag, Praxis Dr. Emilian Buza, was kann ich für Sie tun?"
              Wenn jemand einen Termin möchte, frage nach Datum und Uhrzeit.
              Wenn Datum und Uhrzeit klar sind, bestätige höflich:
              "Perfekt, ich trage das gleich ein." 
              Sprich auf Deutsch.
            `,
            modalities: ["text", "audio"],
            audio: {
              voice: "verse",                 // warme, natürlich klingende Stimme
              format: "wav",
              language: "de",
              gain: 0.85,
              filter: { high_cut: 5500 },     // weniger metallisch
              modulation: {
                pitch: -0.2,
                rate: -0.05,
                energy: -0.1
              }
            },
          },
        })
      );
    });

    // === Twilio → OpenAI: eingehende Audioframes weiterleiten ===
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        // Twilio sendet Base64-Frames im "media"-Event
        if (data.event === "media") {
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            })
          );
        }

        // Wenn der Stream endet
        if (data.event === "stop") {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        }
      } catch (err) {
        console.warn("⚠️ Ungültiges JSON von Twilio:", err);
      }
    });

    // === OpenAI → Twilio: Audioantworten zurücksenden ===
    openaiWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Audiodaten in Richtung Twilio streamen
        if (msg.type === "response.output_audio.delta") {
          ws.send(
            JSON.stringify({
              event: "media",
              media: { payload: msg.delta },
            })
          );
        }

        // Debug-Textausgabe im Log
        if (msg.type === "response.output_text.delta" && msg.delta) {
          console.log("💬", msg.delta);

          // Optionale Kalenderintegration bei erkannten Schlüsselwörtern
          const lower = msg.delta.toLowerCase();
          if (lower.includes("termin") && lower.includes("buchen")) {
            console.log("📅 Termin erkannt – trage in Kalender ein...");

            createCalendarEvent({
              summary: "Neuer Patiententermin",
              description: "Automatisch über Sprachassistent erstellt",
              startISO: new Date().toISOString(),
            })
              .then(() => console.log("✅ Termin erfolgreich eingetragen"))
              .catch((err) =>
                console.error("❌ Fehler beim Eintragen des Termins:", err)
              );
          }
        }
      } catch {
        // nicht parsebares JSON → ignorieren
      }
    });

    // === Aufräumen bei Disconnects ===
    ws.on("close", () => {
      console.log("❌ Twilio-Stream getrennt");
      openaiWs.close();
    });

    openaiWs.on("close", () => console.log("🔚 OpenAI-Session beendet"));
  });
}
