import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createCalendarEvent } from "./calendar.js";
dotenv.config();

const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-10-01";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Realtime-Server: verbindet Twilio Voice Streams mit OpenAI GPT-4 Realtime.
 * Pfad: /media-stream (muss mit TwiML <Stream> übereinstimmen)
 */
export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/media-stream" });
  console.log("🎧 Realtime-Server wartet auf Twilio-Streams...");

  wss.on("connection", (ws) => {
    console.log("📞 Neuer Twilio-Stream verbunden");

    // streamSid ist KRITISCH für Rücksendung an Twilio!
    let streamSid = null;

    // === Verbindung zu OpenAI Realtime herstellen ===
    const openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    // === 1) Session konfigurieren (ZUERST!) ===
    openaiWs.on("open", () => {
      console.log("🧠 Verbunden mit OpenAI Realtime API");

      // Komplette Session-Konfiguration
      const sessionConfig = {
        type: "session.update",
        session: {
          // Server VAD: automatische Erkennung wann User fertig spricht
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,              // Empfindlichkeit (0-1)
            prefix_padding_ms: 300,      // Audio-Vorlauf
            silence_duration_ms: 500,    // Pause = Ende
          },
          // Audio-Format für Twilio (μ-law, 8kHz)
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          // Stimme (WICHTIG: nur alloy, echo, shimmer sind gültig!)
          voice: "alloy",  
          // System-Instructions
          instructions: `Du bist die freundliche, empathische Praxisassistenz der Praxis Dr. Emilian Buza.

Verhalten:
- Sprich natürlich, ruhig und professionell auf Deutsch
- Begrüße Anrufer herzlich: "Guten Tag, Praxis Dr. Emilian Buza, was kann ich für Sie tun?"
- Bei Terminwunsch: frage nach Datum und Uhrzeit
- Bestätige am Ende: "Perfekt, ich trage das gleich für Sie ein."
- Halte Antworten kurz und präzise (max. 2-3 Sätze)`,
          // Audio + Text parallel
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };

      console.log("📤 Konfiguriere Session...");
      openaiWs.send(JSON.stringify(sessionConfig));

      // Nach Session-Update: Begrüßung triggern
      setTimeout(() => {
        console.log("📤 Triggere initiale Begrüßung...");
        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
            },
          })
        );
      }, 250);
    });

    // === 2) Twilio -> OpenAI: Audio-Input weiterleiten ===
    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return; // Ungültiges JSON ignorieren
      }

      // Stream-Start: streamSid extrahieren (KRITISCH!)
      if (data.event === "start") {
        streamSid = data.start?.streamSid || data.streamSid || null;
        console.log("🪪 Twilio streamSid:", streamSid);
        return;
      }

      // Audio-Frames von Twilio → OpenAI
      if (data.event === "media" && data.media?.payload) {
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload, // Base64 μ-law
            })
          );
        }
        return;
      }

      // Stream-Ende signalisieren
      if (data.event === "stop") {
        console.log("🛑 Twilio Stream-Stop");
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
        return;
      }
    });

    // === 3) OpenAI -> Twilio: Audio-Output zurücksenden ===
    let audioChunkCount = 0;

    openaiWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Debug: Session erfolgreich konfiguriert
      if (msg.type === "session.updated") {
        console.log("✅ Session erfolgreich konfiguriert");
      }

      // Debug: Conversation started
      if (msg.type === "response.created") {
        console.log("🎬 OpenAI generiert Antwort...");
        audioChunkCount = 0;
      }

      // Audio-Chunks zurück an Twilio (MIT streamSid!)
      if (msg.type === "response.audio.delta" && msg.delta) {
        audioChunkCount++;
        if (audioChunkCount === 1) {
          console.log("🔊 Audio-Streaming gestartet...");
        }

        if (streamSid && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid: streamSid,  // OHNE das verwirft Twilio die Nachricht!
              media: {
                payload: msg.delta,  // Base64 μ-law von OpenAI
              },
            })
          );
        }
      }

      // Audio fertig
      if (msg.type === "response.audio.done") {
        console.log(`✅ Audio-Response komplett (${audioChunkCount} chunks)`);
      }

      // Transkrip: User-Input
      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        console.log("👤 User sagte:", msg.transcript);
      }

      // Transkrip: Assistant-Output
      if (msg.type === "response.output_item.done" && msg.item?.content) {
        const text = msg.item.content.find((c) => c.type === "text")?.text;
        if (text) {
          console.log("🤖 Assistant:", text);

          // Einfache Heuristik: Termin-Keywords erkennen
          const lower = text.toLowerCase();
          if (
            (lower.includes("termin") || lower.includes("trage")) &&
            (lower.includes("ein") || lower.includes("buchen"))
          ) {
            console.log("📅 Termin-Keyword erkannt → Kalender-Event erstellen");
            try {
              await createCalendarEvent({
                summary: "Neuer Patiententermin (Sprachassistent)",
                description: `Automatisch erstellt\nText: ${text}`,
                startISO: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // +1 Tag
              });
              console.log("✅ Termin erfolgreich eingetragen");
            } catch (err) {
              console.error("❌ Kalender-Fehler:", err.message);
            }
          }
        }
      }

      // Fehler von OpenAI
      if (msg.type === "error") {
        console.error("❌ OpenAI Error:", msg.error);
      }
    });

    // === 4) Cleanup bei Disconnect ===
    ws.on("close", () => {
      console.log("❌ Twilio-Stream getrennt");
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    openaiWs.on("close", () => {
      console.log("🔚 OpenAI-Session beendet");
    });

    openaiWs.on("error", (err) => {
      console.error("❌ OpenAI WebSocket Error:", err.message);
    });
  });
}
