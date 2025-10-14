import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createCalendarEvent } from "./calendar.js";
dotenv.config();

const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-10-01";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * ULTRA-DEBUG VERSION: Loggt ALLES von OpenAI!
 */
export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/media-stream" });
  console.log("🎧 Realtime-Server wartet auf Twilio-Streams...");

  wss.on("connection", (ws) => {
    console.log("📞 Neuer Twilio-Stream verbunden");

    let streamSid = null;
    let eventCount = 0;

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
      console.log("📋 Model:", OPENAI_MODEL);

      // Session-Konfiguration
      const sessionConfig = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],  // BEIDE explizit!
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: "alloy",
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          },
          instructions: `Du bist die freundliche Praxisassistenz der Praxis Dr. Emilian Buza.
Sprich natürlich auf Deutsch.
Begrüße Anrufer: "Guten Tag, Praxis Dr. Emilian Buza, was kann ich für Sie tun?"`,
          temperature: 0.8,
        },
      };

      console.log("📤 SENDE Session-Config:");
      console.log(JSON.stringify(sessionConfig, null, 2));
      openaiWs.send(JSON.stringify(sessionConfig));

      setTimeout(() => {
        console.log("📤 TRIGGERE Response Create:");
        const responseCreate = {
          type: "response.create",
          response: {
            modalities: ["text", "audio"],  // BEIDE!
          },
        };
        console.log(JSON.stringify(responseCreate, null, 2));
        openaiWs.send(JSON.stringify(responseCreate));
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

    // === OpenAI -> Twilio: KOMPLETT LOGGEN ===
    let audioChunkCount = 0;

    openaiWs.on("message", async (raw) => {
      eventCount++;
      
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        console.warn("⚠️ Nicht-JSON:", raw.toString().substring(0, 200));
        return;
      }

      // === JEDES EVENT VOLLSTÄNDIG LOGGEN ===
      console.log(`\n═══ OpenAI Event #${eventCount}: ${msg.type} ═══`);
      
      // Für bestimmte Events: komplettes Objekt
      if (
        msg.type.includes("session") ||
        msg.type.includes("response") ||
        msg.type.includes("audio") ||
        msg.type.includes("error")
      ) {
        console.log(JSON.stringify(msg, null, 2));
      }

      // Session konfiguriert
      if (msg.type === "session.updated") {
        console.log("✅ Session erfolgreich konfiguriert");
        console.log("📋 Session-Details:", JSON.stringify(msg.session, null, 2));
      }

      // Response gestartet
      if (msg.type === "response.created") {
        console.log("🎬 OpenAI generiert Antwort...");
        console.log("📋 Response-Config:", JSON.stringify(msg.response, null, 2));
        audioChunkCount = 0;
      }

      // === ALLE MÖGLICHEN AUDIO-EVENT-NAMEN ===
      const possibleAudioEvents = [
        "response.audio.delta",
        "response.audio_transcript.delta",
        "audio.delta",
        "response.output_audio.delta",
        "conversation.item.audio.delta",
        "response.audio_transcript.done",
        "response.content_part.added",
      ];

      if (possibleAudioEvents.includes(msg.type)) {
        console.log(`🔊 AUDIO-EVENT GEFUNDEN: ${msg.type}`);
        console.log("📋 Komplettes Event:", JSON.stringify(msg, null, 2));
        
        audioChunkCount++;
        const audioData = msg.delta || msg.audio || msg.content;
        
        if (audioData && streamSid && ws.readyState === WebSocket.OPEN) {
          console.log(`📤 Sende Audio-Chunk #${audioChunkCount} an Twilio (${typeof audioData === 'string' ? audioData.length : 'unknown'} bytes)`);
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid: streamSid,
              media: {
                payload: audioData,
              },
            })
          );
        } else {
          console.log(`⚠️ Audio-Chunk #${audioChunkCount} NICHT gesendet:`);
          console.log(`   audioData: ${!!audioData}, streamSid: ${!!streamSid}, ws.open: ${ws.readyState === WebSocket.OPEN}`);
        }
      }

      // Response Items (Text und Audio Content)
      if (msg.type === "response.output_item.added") {
        console.log("📦 Output Item hinzugefügt:", JSON.stringify(msg.item, null, 2));
      }

      // Content Parts
      if (msg.type === "response.content_part.added") {
        console.log("📦 Content Part hinzugefügt:", JSON.stringify(msg.part, null, 2));
      }

      // Audio fertig
      if (msg.type === "response.audio.done") {
        console.log(`✅ Audio komplett (${audioChunkCount} chunks)`);
      }

      // User-Transkrip
      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        console.log("👤 User:", msg.transcript);
      }

      // Assistant-Text
      if (msg.type === "response.text.delta") {
        console.log("💬 Text-Delta:", msg.delta);
      }

      if (msg.type === "response.output_item.done" && msg.item?.content) {
        console.log("📝 Output Item fertig:", JSON.stringify(msg.item, null, 2));
        const text = msg.item.content.find((c) => c.type === "text")?.text;
        if (text) {
          console.log("🤖 Assistant-Text:", text);
        }
      }

      // Response komplett
      if (msg.type === "response.done") {
        console.log("✅ Response abgeschlossen");
        console.log(`   └─ Audio-Chunks gesendet: ${audioChunkCount}`);
        console.log("📋 Finale Response:", JSON.stringify(msg.response, null, 2));
      }

      // Fehler
      if (msg.type === "error") {
        console.error("❌❌❌ OpenAI ERROR:");
        console.error(JSON.stringify(msg, null, 2));
      }
    });

    // === Cleanup ===
    ws.on("close", () => {
      console.log("❌ Twilio-Stream getrennt");
      console.log(`📊 Gesamt OpenAI Events: ${eventCount}`);
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    openaiWs.on("close", () => {
      console.log("🔚 OpenAI-Session beendet");
    });

    openaiWs.on("error", (err) => {
      console.error("❌ OpenAI WebSocket Error:", err.message);
      console.error(err);
    });
  });
}






