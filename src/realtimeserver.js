import { WebSocketServer } from "ws";
import { createClient } from "@deepgram/sdk";
import Groq from "groq-sdk";
import { ElevenLabsClient } from "elevenlabs";
import { v4 as uuidv4 } from "uuid";

// Initialisiere Clients
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/media-stream" });
  console.log("🎧 Realtime-Server wartet auf Twilio-Streams...");

  wss.on("connection", (twilioWs) => {
    console.log("📞 Neue Twilio-Verbindung");

    // Session State
    const sessionId = uuidv4();
    let callId = null;
    let streamSid = null;
    let deepgramConnection = null;
    let conversationHistory = [];
    let isProcessing = false;
    let audioBuffer = "";
    let silenceTimer = null;
    const SILENCE_THRESHOLD = 800; // ms

    // Debug Metrics
    const metrics = {
      startTime: Date.now(),
      audioChunksReceived: 0,
      audioChunksSent: 0,
      transcriptions: 0,
      responses: 0,
    };

    // Deepgram STT Setup
    function setupDeepgram() {
      deepgramConnection = deepgram.listen.live({
        model: "nova-2",
        language: "de",
        smart_format: true,
        interim_results: false,
        endpointing: 800, // Silence detection
        utterance_end_ms: 800,
      });

      deepgramConnection.on("open", () => {
        console.log(`🎤 [${elapsed()}ms] deepgram_connected`);
      });

      deepgramConnection.on("Results", async (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        
        if (transcript && transcript.trim().length > 0) {
          metrics.transcriptions++;
          console.log(`📝 [${elapsed()}ms] transcription`, { text: transcript });
          
          // Verarbeite User-Input
          await handleUserInput(transcript);
        }
      });

      deepgramConnection.on("error", (err) => {
        console.error(`❌ [${elapsed()}ms] deepgram_error`, err);
      });
    }

    // Groq LLM Processing
    async function handleUserInput(userText) {
      if (isProcessing) {
        console.log(`⏸️ [${elapsed()}ms] already_processing`);
        return;
      }

      isProcessing = true;
      console.log(`🧠 [${elapsed()}ms] groq_processing_start`);

      try {
        // Add to conversation history
        conversationHistory.push({
          role: "user",
          content: userText,
        });

        // Call Groq
        const startTime = Date.now();
        const completion = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile", // Schnellstes Groq Model
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

        const groqLatency = Date.now() - startTime;
        const responseText = completion.choices[0]?.message?.content || "";

        console.log(`✅ [${elapsed()}ms] groq_response`, {
          latency_ms: groqLatency,
          text: responseText.substring(0, 100),
        });

        // Add to history
        conversationHistory.push({
          role: "assistant",
          content: responseText,
        });

        metrics.responses++;

        // Check for appointment keywords
        if (responseText.toLowerCase().includes("termin")) {
          console.log(`📅 [${elapsed()}ms] appointment_detected`);
          // TODO: Calendar integration
        }

        // Generate Speech with ElevenLabs
        await generateSpeech(responseText);

      } catch (error) {
        console.error(`❌ [${elapsed()}ms] groq_error`, error.message);
      } finally {
        isProcessing = false;
      }
    }

    // ElevenLabs TTS
    async function generateSpeech(text) {
      console.log(`🔊 [${elapsed()}ms] tts_start`);
      const startTime = Date.now();

      try {
        const audioStream = await elevenlabs.textToSpeech.convert({
          voice_id: "pNInz6obpgDQGcFmaJgB", // Adam voice (German)
          model_id: "eleven_turbo_v2", // Fastest model
          text: text,
          output_format: "ulaw_8000", // Twilio format
        });

        let audioData = Buffer.alloc(0);
        
        for await (const chunk of audioStream) {
          audioData = Buffer.concat([audioData, chunk]);
        }

        const ttsLatency = Date.now() - startTime;
        console.log(`✅ [${elapsed()}ms] tts_complete`, { 
          latency_ms: ttsLatency,
          bytes: audioData.length 
        });

        // Send to Twilio
        sendAudioToTwilio(audioData);

      } catch (error) {
        console.error(`❌ [${elapsed()}ms] tts_error`, error.message);
      }
    }

    // Send Audio to Twilio
    function sendAudioToTwilio(audioBuffer) {
      // Split into chunks (Twilio expects ~20ms chunks)
      const chunkSize = 160; // 20ms of 8kHz ulaw
      let offset = 0;

      while (offset < audioBuffer.length) {
        const chunk = audioBuffer.slice(offset, offset + chunkSize);
        const base64Audio = chunk.toString("base64");

        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid: streamSid,
            media: {
              payload: base64Audio,
            },
          })
        );

        metrics.audioChunksSent++;
        offset += chunkSize;
      }

      console.log(`📤 [${elapsed()}ms] audio_sent`, { chunks: metrics.audioChunksSent });
    }

    // Handle Twilio Messages
    twilioWs.on("message", async (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.event === "start") {
          callId = `call_${Date.now()}`;
          streamSid = msg.start.streamSid;
          console.log(`📞 [${elapsed()}ms] call_start`, { callId, streamSid });
          
          // Setup Deepgram
          setupDeepgram();

          // Send greeting after 1 second
          setTimeout(() => {
            handleUserInput("Hallo"); // Trigger greeting
          }, 1000);
        }

        if (msg.event === "media") {
          metrics.audioChunksReceived++;

          // Decode audio and send to Deepgram
          const audioPayload = Buffer.from(msg.media.payload, "base64");
          
          if (deepgramConnection && deepgramConnection.getReadyState() === 1) {
            deepgramConnection.send(audioPayload);
          }

          // Log every 100 chunks
          if (metrics.audioChunksReceived % 100 === 0) {
            console.log(`⬇️ [${elapsed()}ms] audio_chunks_received`, { 
              total: metrics.audioChunksReceived 
            });
          }
        }

        if (msg.event === "stop") {
          console.log(`🛑 [${elapsed()}ms] stream_stopped`);
          if (deepgramConnection) {
            deepgramConnection.finish();
          }
        }

      } catch (err) {
        console.error(`❌ [${elapsed()}ms] message_error`, err.message);
      }
    });

    twilioWs.on("close", () => {
      console.log(`🔚 [${elapsed()}ms] call_end`);
      
      if (deepgramConnection) {
        deepgramConnection.finish();
      }

      // Print Debug Report
      printDebugReport();
    });

    twilioWs.on("error", (err) => {
      console.error(`❌ [${elapsed()}ms] websocket_error`, err.message);
    });

    // Helper: elapsed time
    function elapsed() {
      return Date.now() - metrics.startTime;
    }

    // Debug Report
    function printDebugReport() {
      const duration = Date.now() - metrics.startTime;
      
      console.log("\n============================================================");
      console.log(`📊 DEBUG REPORT - Call ${callId}`);
      console.log("============================================================\n");
      console.log("📈 METRICS:");
      console.log(`  Audio Chunks Received: ${metrics.audioChunksReceived}`);
      console.log(`  Audio Chunks Sent: ${metrics.audioChunksSent}`);
      console.log(`  Transcriptions: ${metrics.transcriptions}`);
      console.log(`  Responses Generated: ${metrics.responses}`);
      console.log(`  Total Duration: ${duration}ms`);
      console.log("\n============================================================\n");
    }
  });
}


