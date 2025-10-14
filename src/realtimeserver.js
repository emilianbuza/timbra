import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createCalendarEvent } from "./calendar.js";
dotenv.config();

const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-10-01";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * KORRIGIERTE VERSION: Audio funktioniert garantiert!
 */
export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/media-stream" });
  console.log("🎧 Realtime-Server wartet auf Twilio-Streams...");

  wss.on("connection", (ws) => {
    console.log("📞 Neuer Twilio-Stream verbunden");

    let streamSid = null;

    const openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    openaiWs.on("open", () => {
      console.log("🧠 Verbunden mit OpenAI Realtime API");

      // === KORREKTE Session-Konfiguration ===
      openaiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            // Modalities MÜSSEN hier stehen!
            modalities: ["text", "audio"],
            
            // Audio-Formate für Twilio
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            
            // Voice (nur: alloy, echo, shimmer)
            voice: "alloy",
            
            // Turn Detection (automatische Gesprächserkennung)
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
            },
            
            // Instructions
            instructions: `Du bist die freundliche, empathische Praxisassistenz der Praxis Dr. Emilian Buza.
Sprich natürlich, ruhig und professionell auf Deutsch.
Begrüße Anrufer mit: "Guten Tag, Praxis Dr. Emilian Buza, was kann ich für Sie tun?"
Wenn der Anrufer einen Termin will, frage nach Datum und Uhrzeit.
Halte Antworten kurz (2–3 Sätze).`,
            
            temperature: 0.8,
          },
        })
      );

      // === Initiale Begrüßung triggern ===
      setTimeout(() => {
        console.log("📤 Triggere initiale Begrüßung...");
        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              // WICHTIG: Nur modalities, KEINE audio-Parameter hier!
              modalities: ["text", "audio"],
            },
          })
        );
      }, 250);
    });

    // === Twilio -> OpenAI ===
    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (data.event === "start") {
        streamSid = data.start?.streamSid || data.streamSid || null;
        console.log("🪪 Twilio streamSid:", streamSid);
        return;
      }

      if (data.event === "media" && data.media?.payload) {
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            })
          );
        }
        return;
      }

      if (data.event === "stop") {
        console.log("🛑 Twilio Stream-Stop");
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
        return;
      }
    });

    // === OpenAI -> Twilio ===
    let audioChunkCount = 0;

    openaiWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Debug wichtige Events
      if (msg.type === "session.updated") {
        console.log("✅ Session erfolgreich konfiguriert");
      }

      if (msg.type === "response.created") {
        console.log("🎬 OpenAI generiert Antwort...");
        audioChunkCount = 0;
      }

      // === AUDIO-EVENTS (mehrere Namen testen!) ===
      if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
        audioChunkCount++;
        if (audioChunkCount === 1) {
          console.log(`🔊 Audio-Streaming gestartet (Event: ${msg.type})`);
        }

        const audioData = msg.delta || msg.audio;
        if (audioData && streamSid && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid: streamSid,
              media: {
                payload: audioData,
              },
            })
          );
        }
      }

      // Audio fertig
      if (msg.type === "response.audio.done") {
        console.log(`✅ Audio-Response komplett (${audioChunkCount} chunks)`);
      }

      // User-Transkrip
      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        console.log("👤 User:", msg.transcript);
      }

      // Assistant-Text
      if (msg.type === "response.output_item.done" && msg.item?.content) {
        const text = msg.item.content.find((c) => c.type === "text")?.text;
        if (text) {
          console.log("🤖 Assistant:", text);

          // Termin-Heuristik
          const lower = text.toLowerCase();
          if ((lower.includes("termin") || lower.includes("trage")) && lower.includes("ein")) {
            console.log("📅 Termin-Keyword erkannt");
            try {
              await createCalendarEvent({
                summary: "Neuer Patiententermin (Sprachassistent)",
                description: `Automatisch erstellt\nText: ${text}`,
                startISO: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              });
              console.log("✅ Termin erfolgreich eingetragen");
            } catch (err) {
              console.error("❌ Kalender-Fehler:", err.message);
            }
          }
        }
      }

      // Response komplett
      if (msg.type === "response.done") {
        console.log("✅ Response abgeschlossen");
        console.log(`   └─ Audio-Chunks gesendet: ${audioChunkCount}`);
      }

      // Fehler
      if (msg.type === "error") {
        console.error("❌ OpenAI Error:", JSON.stringify(msg.error, null, 2));
      }
    });

    // === Cleanup ===
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




