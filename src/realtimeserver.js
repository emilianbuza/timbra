import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createCalendarEvent } from "./calendar.js";
dotenv.config();

const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-10-01";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * DEBUG VERSION - Zeigt ALLES was passiert
 */

class CallDebugger {
  constructor(callId) {
    this.callId = callId;
    this.startTime = Date.now();
    this.metrics = {
      audioChunksReceived: 0,
      audioChunksSent: 0,
      userSpeechDetected: 0,
      responsesGenerated: 0,
      errors: []
    };
    this.timeline = [];
  }

  log(event, data = {}) {
    const timestamp = Date.now() - this.startTime;
    const entry = {
      time: timestamp,
      event,
      ...data
    };
    this.timeline.push(entry);
    
    // Console Output mit Emoji + Zeit
    const emoji = this.getEmoji(event);
    console.log(`${emoji} [${timestamp}ms] ${event}`, JSON.stringify(data));
  }

  getEmoji(event) {
    const emojiMap = {
      'call_start': '📞',
      'session_configured': '✅',
      'greeting_triggered': '📤',
      'user_speech_start': '🎤',
      'user_speech_end': '⏸️',
      'transcription': '📝',
      'response_start': '🎬',
      'audio_start': '🔊',
      'audio_chunk': '📦',
      'response_end': '✅',
      'error': '❌',
      'warning': '⚠️',
      'performance': '⏱️',
      'call_end': '🔚'
    };
    return emojiMap[event] || '📌';
  }

  generateReport() {
    console.log('\n' + '='.repeat(60));
    console.log(`📊 DEBUG REPORT - Call ${this.callId}`);
    console.log('='.repeat(60));
    
    console.log('\n📈 METRICS:');
    console.log(`  Audio Chunks Received: ${this.metrics.audioChunksReceived}`);
    console.log(`  Audio Chunks Sent: ${this.metrics.audioChunksSent}`);
    console.log(`  User Speech Detected: ${this.metrics.userSpeechDetected}`);
    console.log(`  Responses Generated: ${this.metrics.responsesGenerated}`);
    
    console.log('\n⏱️ PERFORMANCE:');
    const responseTimings = this.timeline
      .filter(e => e.event === 'response_start')
      .map((start, idx) => {
        const end = this.timeline.find((e, i) => 
          i > this.timeline.indexOf(start) && e.event === 'response_end'
        );
        return end ? end.time - start.time : null;
      })
      .filter(t => t !== null);
    
    if (responseTimings.length > 0) {
      const avg = responseTimings.reduce((a, b) => a + b, 0) / responseTimings.length;
      console.log(`  Avg Response Time: ${avg.toFixed(0)}ms`);
      console.log(`  Min Response Time: ${Math.min(...responseTimings)}ms`);
      console.log(`  Max Response Time: ${Math.max(...responseTimings)}ms`);
    }
    
    console.log('\n🔍 ISSUES DETECTED:');
    if (this.metrics.userSpeechDetected === 0) {
      console.log('  ⛔ CRITICAL: No user speech detected! VAD not working!');
    }
    if (this.metrics.responsesGenerated === 0) {
      console.log('  ⛔ CRITICAL: No responses generated!');
    }
    if (this.metrics.audioChunksSent === 0) {
      console.log('  ⛔ CRITICAL: No audio sent to user!');
    }
    if (this.metrics.audioChunksReceived < 10) {
      console.log('  ⚠️ WARNING: Very few audio chunks received from Twilio');
    }
    if (this.metrics.errors.length > 0) {
      console.log(`  ❌ ${this.metrics.errors.length} errors occurred`);
      this.metrics.errors.forEach(err => console.log(`    - ${err}`));
    }
    
    console.log('\n📋 TIMELINE:');
    this.timeline.forEach(entry => {
      console.log(`  ${entry.time}ms: ${entry.event}`);
    });
    
    console.log('\n' + '='.repeat(60) + '\n');
  }
}

export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/media-stream" });
  console.log("🎧 Realtime-Server wartet auf Twilio-Streams...");

  wss.on("connection", (ws) => {
    const callId = `call_${Date.now()}`;
    const debugger = new CallDebugger(callId);
    debugger.log('call_start', { callId });

    let streamSid = null;
    let lastResponseStart = null;
    let lastSpeechStart = null;

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
      debugger.log('openai_connected');

      // Session Config mit allen Details geloggt
      const sessionConfig = {
        type: "session.update",
        session: {
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          modalities: ["text", "audio"],
          voice: "alloy",
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 1200,
          },
          instructions: "Du bist Lea von Praxis Dr. Buza. Begrüße kurz: 'Guten Tag, Praxis Dr. Buza, was kann ich tun?' Antworte kurz (max 2 Sätze). Bei Termin: frage Datum + Uhrzeit.",
          temperature: 0.7,
          max_response_output_tokens: 150,
          input_audio_transcription: {
            model: "whisper-1"
          },
        },
      };
      
      debugger.log('session_config_sent', { 
        vad_threshold: sessionConfig.session.turn_detection.threshold,
        vad_silence_ms: sessionConfig.session.turn_detection.silence_duration_ms,
        temperature: sessionConfig.session.temperature
      });
      
      openaiWs.send(JSON.stringify(sessionConfig));

      setTimeout(() => {
        debugger.log('greeting_triggered');
        openaiWs.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["text", "audio"] },
        }));
      }, 200);
    });

    // === Twilio -> OpenAI ===
    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }

      if (data.event === "start") {
        streamSid = data.start?.streamSid || data.streamSid || null;
        debugger.log('stream_started', { streamSid });
        return;
      }

      if (data.event === "media" && data.media?.payload) {
        debugger.metrics.audioChunksReceived++;
        
        // Log nur jeden 100. Chunk um nicht zu spammen
        if (debugger.metrics.audioChunksReceived % 100 === 0) {
          debugger.log('audio_chunks_received', { 
            total: debugger.metrics.audioChunksReceived 
          });
        }
        
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          }));
        }
        return;
      }

      if (data.event === "stop") {
        debugger.log('stream_stopped');
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

      // Session configured
      if (msg.type === "session.updated") {
        debugger.log('session_configured');
      }

      // Speech detection
      if (msg.type === "input_audio_buffer.speech_started") {
        lastSpeechStart = Date.now();
        debugger.log('user_speech_start');
        debugger.metrics.userSpeechDetected++;
      }

      if (msg.type === "input_audio_buffer.speech_stopped") {
        const duration = lastSpeechStart ? Date.now() - lastSpeechStart : null;
        debugger.log('user_speech_end', { duration_ms: duration });
      }

      // Transcription
      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = msg.transcript || "";
        debugger.log('transcription', { text: transcript });
      }

      // Response lifecycle
      if (msg.type === "response.created") {
        lastResponseStart = Date.now();
        debugger.log('response_start', { responseId: msg.response?.id });
        debugger.metrics.responsesGenerated++;
      }

      // Audio output
      if ((msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") && msg.delta) {
        debugger.metrics.audioChunksSent++;
        
        if (debugger.metrics.audioChunksSent === 1) {
          const latency = lastResponseStart ? Date.now() - lastResponseStart : null;
          debugger.log('audio_start', { 
            latency_ms: latency,
            event_type: msg.type 
          });
        }
        
        // Log nur jeden 50. Chunk
        if (debugger.metrics.audioChunksSent % 50 === 0) {
          debugger.log('audio_chunk', { 
            total_sent: debugger.metrics.audioChunksSent 
          });
        }

        if (streamSid && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: "media",
            streamSid: streamSid,
            media: { payload: msg.delta },
          }));
        }
      }

      if (msg.type === "response.content_part.added" && msg.part?.type === "audio") {
        debugger.log('audio_part_added');
      }

      // Response complete
      if (msg.type === "response.done") {
        const duration = lastResponseStart ? Date.now() - lastResponseStart : null;
        debugger.log('response_end', { 
          duration_ms: duration,
          chunks_sent: debugger.metrics.audioChunksSent
        });

        // Termin-Erkennung
        if (msg.response?.output) {
          const text = msg.response.output
            .filter(item => item.type === "message")
            .flatMap(item => item.content || [])
            .filter(c => c.type === "text")
            .map(c => c.text)
            .join(" ");

          debugger.log('response_text', { text: text.substring(0, 200) });

          if (text.toLowerCase().includes("termin")) {
            debugger.log('appointment_keyword_detected');
            createCalendarEvent({
              summary: "Neuer Patiententermin (Telefon)",
              description: `Call: ${callId}\n\n${text}`,
              startISO: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            }).catch(err => {
              debugger.metrics.errors.push(`Calendar: ${err.message}`);
              debugger.log('error', { type: 'calendar', message: err.message });
            });
          }
        }
      }

      // Errors
      if (msg.type === "error") {
        if (msg.error?.code !== "input_audio_buffer_commit_empty") {
          debugger.metrics.errors.push(`${msg.error?.code}: ${msg.error?.message}`);
          debugger.log('error', { 
            code: msg.error?.code, 
            message: msg.error?.message 
          });
        }
      }

      // Rate limits
      if (msg.type === "rate_limits.updated") {
        debugger.log('rate_limits', { 
          limits: msg.rate_limits 
        });
      }
    });

    // === Cleanup ===
    ws.on("close", () => {
      debugger.log('call_end');
      debugger.generateReport();
      
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    openaiWs.on("close", () => {
      debugger.log('openai_disconnected');
    });

    openaiWs.on("error", (err) => {
      debugger.metrics.errors.push(`WebSocket: ${err.message}`);
      debugger.log('error', { type: 'websocket', message: err.message });
    });
  });
}
