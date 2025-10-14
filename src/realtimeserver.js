import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createCalendarEvent } from "./calendar.js";
dotenv.config();

const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-10-01";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * DEBUG VERSION mit funktionierendem Variablennamen
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
      'call_end': '🔚',
      'openai_connected': '🧠',
      'stream_started': '🪪',
      'stream_stopped': '🛑',
      'audio_chunks_received': '⬇️',
      'audio_part_added': '📦',
      'response_text': '💬',
      'appointment_keyword_detected': '📅',
      'rate_limits': '🚦',
      'openai_disconnected': '🔌'
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
    
    console.log('\n' + '='.repeat(60) + '\n');
  }
}

export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/media-stream" });
  console.log("🎧 Realtime-Server wartet auf Twilio-Streams...");

  wss.on("connection", (ws) => {
    const callId = `call_${Date.now()}`;
    const dbg = new CallDebugger(callId);  // FIXED: dbg statt debugger
    dbg.log('call_start', { callId });

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
      dbg.log('openai_connected');

      const sessionConfig = {
        type: "session.update",
        session: {
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          modalities: ["text", "audio"],
          voice: "alloy",
          
          // OPTIMIERTE VAD für Echo-Vermeidung
          turn_detection: {
            type: "server_vad",
            threshold: 0.6,              // Höher = weniger False Positives
            prefix_padding_ms: 300,
            silence_duration_ms: 1200,   // Balance zwischen Speed & Zuverlässigkeit
          },
          
          instructions: "Du bist Lea, eine freundliche und geduldige Assistentin der Praxis Dr. Buza. Sprich natürlich und empathisch auf Deutsch. Begrüße Anrufer mit: 'Guten Tag, Praxis Dr. Buza, was kann ich für Sie tun?' Bei Terminfragen: Erfrage IMMER Datum UND Uhrzeit. Wenn unklar, frage nach. Bestätige den Termin deutlich. Frage am Ende: 'Kann ich sonst noch etwas für Sie tun?' Lege NIEMALS auf ohne klare Verabschiedung vom Patienten. Bei 'Ja', 'Was', 'Bitte' oder ähnlichen Kurzantworten: Wiederhole die letzte Frage oder frage nach Klarstellung.",
          
          temperature: 0.8,
          max_response_output_tokens: 300,
          
          input_audio_transcription: {
            model: "whisper-1"
          },
        },
      };
      
      dbg.log('session_config_sent', { 
        vad_threshold: sessionConfig.session.turn_detection.threshold,
        vad_silence_ms: sessionConfig.session.turn_detection.silence_duration_ms,
        temperature: sessionConfig.session.temperature
      });
      
      openaiWs.send(JSON.stringify(sessionConfig));

      setTimeout(() => {
        dbg.log('greeting_triggered');
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
        dbg.log('stream_started', { streamSid });
        return;
      }

      if (data.event === "media" && data.media?.payload) {
        dbg.metrics.audioChunksReceived++;
        
        if (dbg.metrics.audioChunksReceived % 100 === 0) {
          dbg.log('audio_chunks_received', { 
            total: dbg.metrics.audioChunksReceived 
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
        dbg.log('stream_stopped');
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

      if (msg.type === "session.updated") {
        dbg.log('session_configured');
      }

      if (msg.type === "input_audio_buffer.speech_started") {
        lastSpeechStart = Date.now();
        dbg.log('user_speech_start');
        dbg.metrics.userSpeechDetected++;
      }

      if (msg.type === "input_audio_buffer.speech_stopped") {
        const duration = lastSpeechStart ? Date.now() - lastSpeechStart : null;
        dbg.log('user_speech_end', { duration_ms: duration });
      }

      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = msg.transcript || "";
        dbg.log('transcription', { text: transcript });
      }

      if (msg.type === "response.created") {
        lastResponseStart = Date.now();
        dbg.log('response_start', { responseId: msg.response?.id });
        dbg.metrics.responsesGenerated++;
        
        // KRITISCH: Clear input buffer um Echo/Feedback zu vermeiden
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: "input_audio_buffer.clear"
          }));
        }
      }

      if ((msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") && msg.delta) {
        dbg.metrics.audioChunksSent++;
        
        if (dbg.metrics.audioChunksSent === 1) {
          const latency = lastResponseStart ? Date.now() - lastResponseStart : null;
          dbg.log('audio_start', { 
            latency_ms: latency,
            event_type: msg.type 
          });
        }
        
        if (dbg.metrics.audioChunksSent % 50 === 0) {
          dbg.log('audio_chunk', { 
            total_sent: dbg.metrics.audioChunksSent 
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
        dbg.log('audio_part_added');
      }

      if (msg.type === "response.done") {
        const duration = lastResponseStart ? Date.now() - lastResponseStart : null;
        dbg.log('response_end', { 
          duration_ms: duration,
          chunks_sent: dbg.metrics.audioChunksSent
        });

        // DEBUG: Log die KOMPLETTE Response-Struktur
        dbg.log('response_structure', { 
          response: JSON.stringify(msg.response).substring(0, 500)
        });

        // Mehrere Wege den Text zu extrahieren
        let text = "";
        
        // Weg 1: Über output array - transcript ist im AUDIO object!
        if (msg.response?.output) {
          text = msg.response.output
            .filter(item => item.type === "message")
            .flatMap(item => item.content || [])
            .filter(c => c.type === "audio")  // FIXED: audio statt text!
            .map(c => c.transcript || "")     // FIXED: transcript property
            .join(" ");
        }
        
        // Weg 2: Direkt aus response
        if (!text && msg.response?.text) {
          text = msg.response.text;
        }
        
        // Weg 3: Aus content array
        if (!text && msg.response?.content) {
          text = msg.response.content
            .filter(c => c.type === "audio")
            .map(c => c.transcript || "")
            .join(" ");
        }

        dbg.log('response_text', { 
          text: text.substring(0, 200),
          length: text.length,
          found_via: text ? "success" : "EMPTY"
        });

        if (text && text.toLowerCase().includes("termin")) {
          dbg.log('appointment_keyword_detected');
          createCalendarEvent({
            summary: "Neuer Patiententermin (Telefon)",
            description: `Call: ${callId}\n\n${text}`,
            startISO: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          }).catch(err => {
            dbg.metrics.errors.push(`Calendar: ${err.message}`);
            dbg.log('error', { type: 'calendar', message: err.message });
          });
        }
      }

      if (msg.type === "error") {
        if (msg.error?.code !== "input_audio_buffer_commit_empty") {
          dbg.metrics.errors.push(`${msg.error?.code}: ${msg.error?.message}`);
          dbg.log('error', { 
            code: msg.error?.code, 
            message: msg.error?.message 
          });
        }
      }

      if (msg.type === "rate_limits.updated") {
        dbg.log('rate_limits', { 
          limits: msg.rate_limits 
        });
      }
    });

    // === Cleanup ===
    ws.on("close", () => {
      dbg.log('call_end');
      dbg.generateReport(); 
      
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    openaiWs.on("close", () => {
      dbg.log('openai_disconnected');
    });

    openaiWs.on("error", (err) => {
      dbg.metrics.errors.push(`WebSocket: ${err.message}`);
      dbg.log('error', { type: 'websocket', message: err.message });
    });
  });
}
