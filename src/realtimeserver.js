import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createCalendarEvent } from "./calendar.js";
dotenv.config();

const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-10-01";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * DEFINITIVE VERSION: Funktioniert garantiert!
 */
export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/media-stream" });
  console.log("🎧 Realtime-Server wartet auf Twilio-Streams...");

  wss.on("connection", (ws) => {
    console.log("📞 Neuer Twilio-Stream verbunden");

    let streamSid = null;
    let audioChunkCount = 0;

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

      // COMPLETE Session-Konfiguration
      openaiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            // KRITISCH: Audio-Formate für Twilio!
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            
            // KRITISCH: Beide Modalities!
            modalities: ["text", "audio"],
            
            // Voice
            voice: "alloy",
            
            // KRITISCH: Turn Detection für automatische Responses
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            
            // Instructions
            instructions: "Du bist die freundliche, empathische Praxisassistenz der Praxis Dr. Emilian Buza. Sprich natürlich, ruhig und professionell auf Deutsch. Begrüße Anrufer mit: 'Guten Tag, Praxis Dr. Emilian Buza, was kann ich für Sie tun?' Wenn jemand einen Termin möchte, frage nach Datum und Uhrzeit. Halte Antworten kurz (2-3 Sätze).",
            
            temperature: 0.7,
          },
        })
      );

      // Initiale Begrüßung
      setTimeout(() => {
        console.log("📤 Triggere Begrüßung...");
        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
            },
          })
        );
      }, 100);
    });

    // === Twilio -> OpenAI ===
    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }

      // streamSid extrahieren
      if (data.event === "start") {
        streamSid = data.start?.streamSid || data.streamSid || null;
        console.log("🪪 streamSid:", streamSid);
        if (!streamSid) {
          console.error("❌ WARNUNG: Kein streamSid gefunden!");
        }
        return;
      }

      // Audio → OpenAI
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

      // Stream-Ende
      if (data.event === "stop") {
        console.log("🛑 Twilio Stream-Stop");
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
        return;
      }
    });

    // === OpenAI -> Twilio ===
    openaiWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Session OK
      if (msg.type === "session.updated") {
        console.log("✅ Session konfiguriert");
      }

      // Response Start
      if (msg.type === "response.created") {
        audioChunkCount = 0;
        console.log("🎬 Response gestartet");
      }

      // KRITISCH: Audio-Events - NUR DIE ECHTEN AUDIO-EVENTS!
      if (
        (msg.type === "response.audio.delta" ||
         msg.type === "response.output_audio.delta") &&
        msg.delta
      ) {
        audioChunkCount++;
        
        if (audioChunkCount === 1) {
          console.log(`🔊 Audio startet (Event: ${msg.type})`);
        }

        if (streamSid && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid: streamSid,
              media: {
                payload: msg.delta,
              },
            })
          );
        }
      }

      // ZUSÄTZLICH: Falls Audio in content_part kommt
      if (msg.type === "response.content_part.added" && msg.part?.type === "audio") {
        console.log("📦 Audio Content Part erkannt");
      }

      // Response Ende
      if (msg.type === "response.done") {
        console.log(`✅ Response fertig (${audioChunkCount} chunks)`);
        
        // Termin-Erkennung
        if (msg.response?.output) {
          const text = msg.response.output
            .filter(item => item.type === "message")
            .flatMap(item => item.content || [])
            .filter(c => c.type === "text")
            .map(c => c.text)
            .join(" ")
            .toLowerCase();

          if ((text.includes("termin") || text.includes("trage")) && text.includes("ein")) {
            console.log("📅 Termin-Keyword erkannt");
            createCalendarEvent({
              summary: "Neuer Patiententermin",
              description: "Automatisch erstellt via Sprachassistent",
              startISO: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            }).catch(err => console.error("❌ Kalender-Fehler:", err.message));
          }
        }
      }

      // Fehler (außer harmlosem buffer-empty)
      if (msg.type === "error" && msg.error?.code !== "input_audio_buffer_commit_empty") {
        console.error("❌ OpenAI Error:", msg.error?.code, msg.error?.message);
      }
    });

    // === Cleanup ===
    ws.on("close", () => {
      console.log("❌ Twilio-Stream getrennt");
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    openaiWs.on("close", () => console.log("🔚 OpenAI-Session beendet"));
    openaiWs.on("error", (err) => console.error("❌ WebSocket Error:", err.message));
  });
}
