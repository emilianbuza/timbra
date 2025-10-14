import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createCalendarEvent } from "./calendar.js";
dotenv.config();

// KRITISCH: Stabiler Alias für die Realtime API
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * FINALE, OPTIMIERTE VERSION für SCHNELLE und ZUVERLÄSSIGE Responses
 */
export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/media-stream" });
  console.log("🎧 Realtime-Server wartet auf Twilio-Streams...");

  wss.on("connection", (ws) => {
    console.log("📞 Neuer Twilio-Stream verbunden");

    let streamSid = null;
    let audioChunkCount = 0;
    let conversationContext = ""; // Für besseren Context-Tracking

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

      // OPTIMIERTE Session-Konfiguration
      openaiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            // KRITISCH: Audio-Formate für Twilio
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
                        
            // KRITISCH: Beide Modalities
            modalities: ["text", "audio"],
                        
            // Voice
            voice: "alloy",
                        
            // OPTIMIERTE Turn Detection für SCHNELLE Antworten und natürliche deutsche Pausen
            turn_detection: {
              type: "server_vad",
              threshold: 0.6,               // Aggressive VAD
              prefix_padding_ms: 200,       // Weniger Padding = schneller
              silence_duration_ms: 800,     // Optimaler Wert, um den Benutzer nicht zu unterbrechen
            },
                        
            // KÜRZERE Instructions = schnellere Verarbeitung & Fokus
            instructions: "Du bist Lea von Praxis Dr. Buza. Begrüße kurz: 'Guten Tag, Praxis Dr. Buza, was kann ich tun?' Antworte SEHR kurz (max 1-2 Sätze). Bei Termin: frage Datum + Uhrzeit. Sei natürlich und schnell.",
                        
            // KRITISCH: Niedrige Temperatur für ZUVERLÄSSIGE Konsistenz
            temperature: 0.6,               // Konservativer Wert für zuverlässige Antworten
            max_response_output_tokens: 150, // Begrenzt Länge der Antworten

            // Transcription aktivieren (neu für Debugging)
            input_audio_transcription: {
              model: "whisper-1"
            },
          },
        })
      );

      // Initiale Begrüßung schneller triggern
      setTimeout(() => {
        console.log("📤 Triggere Begrüßung...");
        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
              instructions: "Begrüße den Anrufer sofort mit 'Guten Tag, Praxis Dr. Buza, was kann ich für Sie tun?'"
            },
          })
        );
      }, 50); // Extrem schnelles Start-Timing
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

      // INPUT TRANSCRIPTION (neu für Debugging)
      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = msg.transcript || "";
        console.log(`🎤 User sagte: "${transcript}"`);
        conversationContext += `User: ${transcript}\n`;
      }

      // Response Start
      if (msg.type === "response.created") {
        audioChunkCount = 0;
        const responseId = msg.response?.id || "unknown";
        console.log(`🎬 Response ${responseId} gestartet`);
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

      // Content Part für Logging
      if (msg.type === "response.content_part.added" && msg.part?.type === "audio") {
        console.log("📦 Audio Content Part erkannt");
      }

      // Response Text Tracking (für Context)
      if (msg.type === "response.audio_transcript.delta") {
        const delta = msg.delta || "";
        conversationContext += delta;
      }

      // Response Ende mit Analyse
      if (msg.type === "response.done") {
        const duration = audioChunkCount > 0 ? "OK" : "KEIN AUDIO!";
        console.log(`✅ Response fertig (${audioChunkCount} chunks) - ${duration}`);
                
        // Termin-Erkennung
        if (msg.response?.output) {
          const text = msg.response.output
            .filter(item => item.type === "message")
            .flatMap(item => item.content || [])
            .filter(c => c.type === "text")
            .map(c => c.text)
            .join(" ")
            .toLowerCase();

          console.log(`🔍 Response Text: "${text.substring(0, 100)}..."`);
          conversationContext += `Assistant: ${text}\n`;

          if ((text.includes("termin") || text.includes("trage")) && 
              (text.includes("ein") || text.includes("buche"))) {

            console.log("📅 Termin-Keyword erkannt - erstelle Event");

            createCalendarEvent({
              summary: "Neuer Patiententermin (Telefon)",
              description: `Automatisch via Sprachassistent erstellt\n\nGesprächskontext:\n${conversationContext}`,
              startISO: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            }).catch(err => console.error("❌ Kalender-Fehler:", err.message));
          }
        }
      }

      // Fehlerbehandlung (außer harmlosem buffer-empty)
      if (msg.type === "error") {
        if (msg.error?.code === "input_audio_buffer_commit_empty") {
          // Harmlos - ignorieren
        } else {
          console.error("❌ OpenAI Error:", msg.error?.code, msg.error?.message);
        }
      }

      // Rate Limits warnen
      if (msg.type === "rate_limits.updated") {
        console.log("⚠️ Rate Limits Update:", JSON.stringify(msg.rate_limits));
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

