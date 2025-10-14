import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createCalendarEvent } from "./calendar.js";
dotenv.config();

const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-10-01";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Twilio sendet Audio im μ-law Format (8kHz)
const TWILIO_AUDIO_FORMAT = "g711_ulaw";

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
    
    let streamSid = null;

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

      // KRITISCH: Erst Session konfigurieren, DANN Response triggern!
      const sessionConfig = {
        type: "session.update",
        session: {
          turn_detection: {
            type: "server_vad",  // Server erkennt automatisch wann User fertig ist
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
          input_audio_format: TWILIO_AUDIO_FORMAT,
          output_audio_format: TWILIO_AUDIO_FORMAT,
          voice: "alloy",  // Verfügbare: alloy, echo, shimmer
          instructions: `Du bist die freundliche, empathische Praxisassistenz der Praxis Dr. Emilian Buza.

Wichtige Verhaltensregeln:
- Sprich natürlich, ruhig und professionell auf Deutsch
- Begrüße Anrufer herzlich: "Guten Tag, Praxis Dr. Emilian Buza, was kann ich für Sie tun?"
- Wenn jemand einen Termin möchte, frage nach Wunschdatum und Uhrzeit
- Bestätige am Ende: "Perfekt, ich trage das gleich für Sie ein."
- Sei geduldig und wiederhole gerne Informationen
- Halte dich kurz und präzise`,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };

      console.log("📤 Sende Session-Konfiguration...");
      openaiWs.send(JSON.stringify(sessionConfig));

      // Nach Session-Update: Begrüßung triggern
      setTimeout(() => {
        console.log("📤 Triggere initiale Begrüßung...");
        openaiWs.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["text", "audio"],
          }
        }));
      }, 250);
    });

    // === Twilio → OpenAI: eingehende Audioframes weiterleiten ===
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        // Stream-Start
        if (data.event === "start") {
          streamSid = data.start.streamSid;
          console.log(`🎤 Stream gestartet: ${streamSid}`);
        }

        // Twilio sendet Base64-Frames im "media"-Event
        if (data.event === "media" && data.media?.payload) {
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            })
          );
        }

        // Wenn der Stream endet
        if (data.event === "stop") {
          console.log("🛑 Stream-Stop erkannt");
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
      } catch (err) {
        console.warn("⚠️ Ungültiges JSON von Twilio:", err.message);
      }
    });

    // === OpenAI → Twilio: Audioantworten zurücksenden ===
    let audioChunksSent = 0;

    openaiWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Debug: Session erfolgreich aktualisiert
        if (msg.type === "session.updated") {
          console.log("✅ Session konfiguriert!");
        }

        // Debug: Response gestartet
        if (msg.type === "response.output_item.added") {
          console.log("🎬 OpenAI beginnt Antwort...");
        }

        // Audiodaten in Richtung Twilio streamen
        if (msg.type === "response.audio.delta" && msg.delta) {
          audioChunksSent++;
          if (audioChunksSent === 1) {
            console.log("🔊 Erste Audio-Chunks werden gesendet...");
          }
          
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid: streamSid,
              media: { 
                payload: msg.delta 
              },
            })
          );
        }

        // Response fertig
        if (msg.type === "response.audio.done") {
          console.log(`✅ Audio-Response abgeschlossen (${audioChunksSent} chunks)`);
          audioChunksSent = 0;
        }

        // Transkrip-Ausgabe für Debugging
        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          console.log("👤 User:", msg.transcript);
        }

        if (msg.type === "response.output_item.done" && msg.item?.content) {
          const text = msg.item.content.find(c => c.type === "text")?.text;
          if (text) {
            console.log("🤖 Assistant:", text);

            // Optionale Kalenderintegration bei Schlüsselwörtern
            const lower = text.toLowerCase();
            if (lower.includes("trage") && lower.includes("ein")) {
              console.log("📅 Termin erkannt – trage in Kalender ein...");

              createCalendarEvent({
                summary: "Neuer Patiententermin",
                description: "Automatisch über Sprachassistent erstellt",
                startISO: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              })
                .then(() => console.log("✅ Termin erfolgreich eingetragen"))
                .catch((err) =>
                  console.error("❌ Fehler beim Eintragen des Termins:", err)
                );
            }
          }
        }

        // Fehlerbehandlung
        if (msg.type === "error") {
          console.error("❌ OpenAI Error:", msg.error);
        }

      } catch (err) {
        // Nicht-JSON oder Parsing-Fehler ignorieren
        console.warn("⚠️ OpenAI message parse error:", err.message);
      }
    });

    // === Aufräumen bei Disconnects ===
    ws.on("close", () => {
      console.log("❌ Twilio-Stream getrennt");
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    openaiWs.on("close", () => console.log("🔚 OpenAI-Session beendet"));

    openaiWs.on("error", (err) => {
      console.error("❌ OpenAI WebSocket Error:", err.message);
    });
  });
}
