import { WebSocketServer } from "ws";
import { createClient } from "@deepgram/sdk";
import Groq from "groq-sdk";
import { ElevenLabsClient } from "elevenlabs";
import { v4 as uuidv4 } from "uuid";

console.log("🔍 API Key Checks:");
console.log("  DEEPGRAM:", process.env.DEEPGRAM_API_KEY ? `${process.env.DEEPGRAM_API_KEY.substring(0, 10)}... (${process.env.DEEPGRAM_API_KEY.length} chars)` : "❌ MISSING");
console.log("  GROQ:", process.env.GROQ_API_KEY ? `${process.env.GROQ_API_KEY.substring(0, 10)}... (${process.env.GROQ_API_KEY.length} chars)` : "❌ MISSING");
console.log("  ELEVENLABS:", process.env.ELEVENLABS_API_KEY ? `${process.env.ELEVENLABS_API_KEY.substring(0, 10)}... (${process.env.ELEVENLABS_API_KEY.length} chars)` : "❌ MISSING");

let deepgram, groq, elevenlabs;

try {
  deepgram = createClient(process.env.DEEPGRAM_API_KEY);
  console.log("✅ Deepgram Client erstellt");
} catch (err) {
  console.error("❌ Deepgram Init Error:", err.message);
  process.exit(1);
}

try {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  console.log("✅ Groq Client erstellt");
} catch (err) {
  console.error("❌ Groq Init Error:", err.message);
  process.exit(1);
}

try {
  elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
  console.log("✅ ElevenLabs Client erstellt");
} catch (err) {
  console.error("❌ ElevenLabs Init Error:", err.message);
  process.exit(1);
}

export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/media-stream" });
  console.log("🎧 Realtime-Server bereit auf /media-stream");

  wss.on("connection", (twilioWs) => {
    const sessionId = uuidv4();
    const startTime = Date.now();
    
    console.log("\n" + "=".repeat(80));
    console.log(`📞 NEUE VERBINDUNG [${sessionId.substring(0, 8)}]`);
    console.log("=".repeat(80));

    let callId = null;
    let streamSid = null;
    let deepgramConnection = null;
    let conversationHistory = [];
    let isProcessing = false;
    let deepgramReady = false;

    const metrics = {
      sessionId,
      startTime,
      twilioConnected: false,
      deepgramConnected: false,
      audioChunksReceived: 0,
      audioBytesSentToDeepgram: 0,
      deepgramResults: 0,
      transcriptionsReceived: 0,
      emptyTranscriptions: 0,
      groqRequests: 0,
      groqResponses: 0,
      groqErrors: 0,
      ttsRequests: 0,
      ttsResponses: 0,
      ttsErrors: 0,
      audioChunksSentToTwilio: 0,
      audioBytesSentToTwilio: 0,
      events: [],
      errors: []
    };

    function log(type, message, data = null) {
      const timestamp = Date.now() - startTime;
      const entry = {
        time: timestamp,
        type,
        message,
        data
      };
      metrics.events.push(entry);
      
      const emoji = {
        'info': 'ℹ️',
        'success': '✅',
        'warning': '⚠️',
        'error': '❌',
        'deepgram': '🎤',
        'groq': '🧠',
        'elevenlabs': '🔊',
        'twilio': '📞',
        'audio': '🔉',
        'transcript': '📝'
      }[type] || '•';

      console.log(`${emoji} [${timestamp}ms] ${message}`, data ? JSON.stringify(data).substring(0, 200) : '');
    }

    function setupDeepgram() {
      log('deepgram', 'Starte Deepgram Connection Setup...');
      
      const config = {
        model: "nova-2",
        language: "de",
        encoding: "mulaw",
        sample_rate: 8000,
        channels: 1,
        smart_format: true,
        interim_results: false,
        endpointing: 800,
        utterance_end_ms: 800,
      };
      
      log('deepgram', 'Deepgram Config:', config);

      try {
        deepgramConnection = deepgram.listen.live(config);
        
        deepgramConnection.on("open", () => {
          deepgramReady = true;
          metrics.deepgramConnected = true;
          log('success', 'Deepgram Connection OPEN');
        });

        deepgramConnection.on("Results", async (data) => {
          metrics.deepgramResults++;
          
          log('deepgram', `Deepgram Results Event #${metrics.deepgramResults}`);
          log('deepgram', 'Raw Deepgram Data:', {
            hasChannel: !!data.channel,
            hasAlternatives: !!data.channel?.alternatives,
            alternativesCount: data.channel?.alternatives?.length || 0
          });
          
          const transcript = data.channel?.alternatives?.[0]?.transcript;
          const confidence = data.channel?.alternatives?.[0]?.confidence;
          
          if (transcript && transcript.trim().length > 0) {
            metrics.transcriptionsReceived++;
            log('transcript', `Transkription #${metrics.transcriptionsReceived}: "${transcript}"`, {
              confidence,
              length: transcript.length
            });
            await handleUserInput(transcript);
          } else {
            metrics.emptyTranscriptions++;
            log('warning', `Leere Transkription (Total: ${metrics.emptyTranscriptions})`);
          }
        });

        deepgramConnection.on("error", (err) => {
          metrics.errors.push({ time: Date.now() - startTime, component: 'deepgram', error: String(err) });
          log('error', 'Deepgram Error:', {
            message: err.message,
            type: err.type,
            code: err.code,
            string: String(err)
          });
        });

        deepgramConnection.on("close", (code, reason) => {
          deepgramReady = false;
          log('warning', 'Deepgram Connection Closed', { code, reason });
        });

        deepgramConnection.on("warning", (warning) => {
          log('warning', 'Deepgram Warning:', warning);
        });

        deepgramConnection.on("metadata", (metadata) => {
          log('info', 'Deepgram Metadata:', metadata);
        });

        deepgramConnection.on("UtteranceEnd", () => {
          log('info', 'Deepgram UtteranceEnd Event');
        });

        deepgramConnection.on("SpeechStarted", () => {
          log('info', 'Deepgram SpeechStarted Event');
        });

      } catch (err) {
        metrics.errors.push({ time: Date.now() - startTime, component: 'deepgram_setup', error: err.message });
        log('error', 'Deepgram Setup Error:', { message: err.message, stack: err.stack });
      }
    }

    async function handleUserInput(userText) {
      if (isProcessing) {
        log('warning', 'Bereits am Verarbeiten - Skip');
        return;
      }

      isProcessing = true;
      metrics.groqRequests++;
      log('groq', `Groq Request #${metrics.groqRequests} für Text: "${userText}"`);

      try {
        conversationHistory.push({
          role: "user",
          content: userText,
        });

        log('groq', 'Sende an Groq...', {
          model: "llama-3.3-70b-versatile",
          historyLength: conversationHistory.length,
          temperature: 0.7,
          maxTokens: 150
        });
        
        const groqStart = Date.now();
        const completion = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content: `Du bist Lea, Assistentin von Praxis Dr. Buza. 
Begrüße freundlich: 'Guten Tag, Praxis Dr. Buza, was kann ich für Sie tun?'
Bei Terminfragen: Erfrage Datum UND Uhrzeit. Bestätige klar.
Bei unklaren Antworten: Frage höflich nach.
Lege nur auf wenn Patient sich klar verabschiedet.
Antworte kurz und präzise (max 2 Sätze).`,
            },
            ...conversationHistory,
          ],
          temperature: 0.7,
          max_tokens: 150,
        });

        const groqLatency = Date.now() - groqStart;
        const responseText = completion.choices[0]?.message?.content || "";

        metrics.groqResponses++;
        log('success', `Groq Response #${metrics.groqResponses} (${groqLatency}ms): "${responseText}"`, {
          finishReason: completion.choices[0]?.finish_reason,
          tokensUsed: completion.usage
        });

        conversationHistory.push({
          role: "assistant",
          content: responseText,
        });

        await generateSpeech(responseText);

      } catch (error) {
        metrics.groqErrors++;
        metrics.errors.push({ time: Date.now() - startTime, component: 'groq', error: error.message });
        log('error', 'Groq Error:', {
          message: error.message,
          status: error.status,
          type: error.type,
          stack: error.stack
        });
      } finally {
        isProcessing = false;
      }
    }

    async function generateSpeech(text) {
      metrics.ttsRequests++;
      log('elevenlabs', `TTS Request #${metrics.ttsRequests} für: "${text.substring(0, 50)}..."`);

      const ttsStart = Date.now();

      try {
        log('elevenlabs', 'Sende an ElevenLabs...', {
          voiceId: 'pNInz6obpgDQGcFmaJgB',
          model: 'eleven_turbo_v2',
          format: 'ulaw_8000',
          textLength: text.length
        });

        const audioStream = await elevenlabs.textToSpeech.convert(
          "pNInz6obpgDQGcFmaJgB",
          {
            text: text,
            model_id: "eleven_turbo_v2",
            output_format: "ulaw_8000"
          }
        );

        log('success', 'ElevenLabs Stream erhalten');

        let audioData = Buffer.alloc(0);
        let chunkCount = 0;
        
        for await (const chunk of audioStream) {
          audioData = Buffer.concat([audioData, chunk]);
          chunkCount++;
          
          if (chunkCount === 1) {
            log('audio', 'Erstes Audio-Chunk empfangen', { bytes: chunk.length });
          }
        }

        const ttsLatency = Date.now() - ttsStart;
        metrics.ttsResponses++;
        
        log('success', `TTS Response #${metrics.ttsResponses} (${ttsLatency}ms)`, {
          totalBytes: audioData.length,
          chunks: chunkCount,
          avgChunkSize: Math.round(audioData.length / chunkCount)
        });

        sendAudioToTwilio(audioData);

      } catch (error) {
        metrics.ttsErrors++;
        metrics.errors.push({ time: Date.now() - startTime, component: 'elevenlabs', error: error.message });
        log('error', 'ElevenLabs Error:', {
          message: error.message,
          name: error.name,
          status: error.status,
          stack: error.stack
        });
      }
    }

    function sendAudioToTwilio(audioBuffer) {
      log('twilio', 'Sende Audio an Twilio...', {
        totalBytes: audioBuffer.length,
        streamSid: streamSid
      });
      
      const chunkSize = 160;
      let offset = 0;
      let chunks = 0;

      while (offset < audioBuffer.length) {
        const chunk = audioBuffer.slice(offset, offset + chunkSize);
        const base64Audio = chunk.toString("base64");

        try {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid: streamSid,
              media: {
                payload: base64Audio,
              },
            })
          );

          metrics.audioChunksSentToTwilio++;
          metrics.audioBytesSentToTwilio += chunk.length;
          chunks++;
          offset += chunkSize;
        } catch (err) {
          metrics.errors.push({ time: Date.now() - startTime, component: 'twilio_send', error: err.message });
          log('error', 'Twilio Send Error:', { message: err.message });
          break;
        }
      }

      log('success', `Audio an Twilio gesendet: ${chunks} chunks, ${audioBuffer.length} bytes`);
    }

    twilioWs.on("message", async (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.event === "start") {
          callId = `call_${Date.now()}`;
          streamSid = msg.start.streamSid;
          metrics.twilioConnected = true;
          
          log('twilio', 'Stream Start', {
            callId,
            streamSid,
            tracks: msg.start.tracks,
            mediaFormat: msg.start.mediaFormat,
            customParameters: msg.start.customParameters
          });
          
          setupDeepgram();

          setTimeout(() => {
            log('info', 'Triggere Begrüßung...');
            handleUserInput("Hallo");
          }, 1000);
        }

        if (msg.event === "media") {
          metrics.audioChunksReceived++;
          const audioPayload = Buffer.from(msg.media.payload, "base64");
          metrics.audioBytesSentToDeepgram += audioPayload.length;
          
          if (metrics.audioChunksReceived === 1) {
            log('audio', 'Erstes Audio von Twilio', {
              bytes: audioPayload.length,
              timestamp: msg.media.timestamp
            });
          }
          
          if (deepgramConnection && deepgramReady) {
            const state = deepgramConnection.getReadyState();
            
            if (state === 1) { // OPEN
              deepgramConnection.send(audioPayload);
              
              if (metrics.audioChunksReceived === 1) {
                log('success', 'Erstes Audio an Deepgram gesendet');
              }
            } else {
              log('error', `Deepgram State=${state} (nicht OPEN=1)`, {
                audioChunk: metrics.audioChunksReceived
              });
            }
          } else {
            if (metrics.audioChunksReceived === 1) {
              log('error', 'Deepgram nicht bereit!', {
                connectionExists: !!deepgramConnection,
                ready: deepgramReady
              });
            }
          }

          if (metrics.audioChunksReceived % 100 === 0) {
            log('info', 'Audio Progress', {
              chunks: metrics.audioChunksReceived,
              bytes: metrics.audioBytesSentToDeepgram,
              transcriptions: metrics.transcriptionsReceived
            });
          }
        }

        if (msg.event === "stop") {
          log('twilio', 'Stream Stop Event');
          if (deepgramConnection) {
            deepgramConnection.finish();
          }
        }

      } catch (err) {
        metrics.errors.push({ time: Date.now() - startTime, component: 'message_handler', error: err.message });
        log('error', 'Message Handler Error:', { message: err.message, stack: err.stack });
      }
    });

    twilioWs.on("close", () => {
      log('twilio', 'WebSocket Closed');
      
      if (deepgramConnection) {
        deepgramConnection.finish();
      }

      printDebugReport();
    });

    twilioWs.on("error", (err) => {
      metrics.errors.push({ time: Date.now() - startTime, component: 'websocket', error: err.message });
      log('error', 'WebSocket Error:', { message: err.message, stack: err.stack });
    });

    function printDebugReport() {
      const duration = Date.now() - startTime;
      
      console.log("\n" + "=".repeat(80));
      console.log(`📊 DEBUG REPORT - Session ${sessionId.substring(0, 8)}`);
      console.log("=".repeat(80));
      
      console.log("\n🔌 CONNECTIONS:");
      console.log(`  Twilio: ${metrics.twilioConnected ? '✅' : '❌'}`);
      console.log(`  Deepgram: ${metrics.deepgramConnected ? '✅' : '❌'}`);
      
      console.log("\n🎤 AUDIO FLOW:");
      console.log(`  Twilio → Server: ${metrics.audioChunksReceived} chunks (${metrics.audioBytesSentToDeepgram} bytes)`);
      console.log(`  Server → Deepgram: ${metrics.audioBytesSentToDeepgram} bytes`);
      console.log(`  Server → Twilio: ${metrics.audioChunksSentToTwilio} chunks (${metrics.audioBytesSentToTwilio} bytes)`);
      
      console.log("\n📝 TRANSCRIPTION:");
      console.log(`  Deepgram Results Events: ${metrics.deepgramResults}`);
      console.log(`  Valid Transcriptions: ${metrics.transcriptionsReceived}`);
      console.log(`  Empty Transcriptions: ${metrics.emptyTranscriptions}`);
      
      console.log("\n🧠 GROQ:");
      console.log(`  Requests: ${metrics.groqRequests}`);
      console.log(`  Responses: ${metrics.groqResponses}`);
      console.log(`  Errors: ${metrics.groqErrors}`);
      
      console.log("\n🔊 TTS:");
      console.log(`  Requests: ${metrics.ttsRequests}`);
      console.log(`  Responses: ${metrics.ttsResponses}`);
      console.log(`  Errors: ${metrics.ttsErrors}`);
      
      console.log("\n⏱️ TIMING:");
      console.log(`  Total Duration: ${duration}ms (${(duration/1000).toFixed(1)}s)`);
      
      if (metrics.errors.length > 0) {
        console.log("\n❌ ERRORS:");
        metrics.errors.forEach(err => {
          console.log(`  [${err.time}ms] ${err.component}: ${err.error}`);
        });
      }
      
      console.log("\n📋 CRITICAL CHECKS:");
      if (metrics.audioChunksReceived === 0) {
        console.log("  ⛔ KEINE Audio von Twilio empfangen!");
      }
      if (metrics.deepgramResults === 0) {
        console.log("  ⛔ KEINE Deepgram Results Events!");
      }
      if (metrics.transcriptionsReceived === 0) {
        console.log("  ⛔ KEINE validen Transkriptionen!");
      }
      if (metrics.groqResponses === 0) {
        console.log("  ⛔ KEINE Groq Responses!");
      }
      if (metrics.ttsResponses === 0) {
        console.log("  ⛔ KEINE TTS Responses!");
      }
      if (metrics.audioChunksSentToTwilio === 0) {
        console.log("  ⛔ KEIN Audio zurück an Twilio gesendet!");
      }
      
      console.log("\n" + "=".repeat(80) + "\n");
    }
  });
}
