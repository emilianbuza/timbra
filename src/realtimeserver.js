import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createCalendarEvent } from "./calendar.js";
dotenv.config();

const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-10-01";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * PRODUCTION VERSION: Optimiert für Geschwindigkeit!
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

      // === SPEED-OPTIMIERTE Session-Konfiguration ===
      openaiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            voice: "alloy",
            
            // KRITISCH: Schnellere Turn Detection!
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 200,  // ⚡ Reduziert von 600ms → 200ms!
            },
            
            // KURZE Instructions = schnellere Antworten
            instructions: "Du bist Lea von Praxis Dr. Buza. Sprich Deutsch, kurz und freundlich. Begrüße mit: 'Praxis Dr. Buza, guten Tag!'",
            
            // Niedrigere Temperature = schneller
            temperature: 0.7,  // ⚡ Reduziert von 0.8 → 0.7
          },
        })
      );

      // Initiale Begrüßung triggern
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
      }, 100);  // ⚡ Reduziert von 250ms → 100ms
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
        console.log("🪪 streamSid:", streamSid);
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
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
        return;
      }
    });

    // === OpenAI -> Twilio (NUR WICHTIGE LOGS!) ===
    let audioChunkCount = 0;
    let responseStartTime = null;

    openaiWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Session konfiguriert
      if (msg.type === "session.updated") {
        console.log("✅ Session konfiguriert");
      }

      // Response gestartet
      if (msg.type === "response.created") {
        responseStartTime = Date.now();
        audioChunkCount = 0;
      }

      // Audio-Chunks (MIT streamSid!)
      if (msg.type === "response.audio.delta" && msg.delta) {
        audioChunkCount++;
        
        if (audioChunkCount === 1) {
          const latency = Date.now() - responseStartTime;
          console.log(`🔊 Audio startet (${latency}ms Latenz)`);
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

      // Response fertig
      if (msg.type === "response.done") {
        const totalTime = Date.now() - responseStartTime;
        console.log(`✅ Response fertig (${totalTime}ms, ${audioChunkCount} chunks)`);
        
        // Termin-Erkennung (optional)
        if (msg.response?.output) {
          const text = msg.response.output
            .filter(item => item.type === "message")
            .flatMap(item => item.content)
            .filter(c => c.type === "text")
            .map(c => c.text)
            .join(" ")
            .toLowerCase();

          if ((text.includes("termin") || text.includes("trage")) && text.includes("ein")) {
            console.log("📅 Termin-Keyword erkannt");
            createCalendarEvent({
              summary: "Neuer Patiententermin",
              description: "Automatisch erstellt",
              startISO: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            }).catch(err => console.error("❌ Kalender-Fehler:", err.message));
          }
        }
      }

      // Nur kritische Fehler loggen
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
