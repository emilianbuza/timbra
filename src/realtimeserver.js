import { WebSocketServer } from "ws";
import { createClient } from "@deepgram/sdk";
import Groq from "groq-sdk";
import { ElevenLabsClient } from "elevenlabs";
import { v4 as uuidv4 } from "uuid";

// API Key Checks
console.log("🔍 Checking API Keys...");
console.log("  DEEPGRAM_API_KEY:", process.env.DEEPGRAM_API_KEY ? `${process.env.DEEPGRAM_API_KEY.substring(0, 10)}...` : "❌ MISSING");
console.log("  GROQ_API_KEY:", process.env.GROQ_API_KEY ? "✅ Set" : "❌ MISSING");
console.log("  ELEVENLABS_API_KEY:", process.env.ELEVENLABS_API_KEY ? "✅ Set" : "❌ MISSING");

// Initialisiere Clients
let deepgram, groq, elevenlabs;

try {
  console.log("🔧 Initialisiere Deepgram...");
  if (!process.env.DEEPGRAM_API_KEY) {
    throw new Error("DEEPGRAM_API_KEY ist nicht gesetzt!");
  }
  deepgram = createClient(process.env.DEEPGRAM_API_KEY);
  console.log("✅ Deepgram initialisiert");
} catch (err) {
  console.error("❌ Deepgram Init Error:", err.message);
}

try {
  console.log("🔧 Initialisiere Groq...");
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  console.log("✅ Groq initialisiert");
} catch (err) {
  console.error("❌ Groq Init Error:", err);
}

try {
  console.log("🔧 Initialisiere ElevenLabs...");
  elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
  console.log("✅ ElevenLabs initialisiert");
} catch (err) {
  console.error("❌ ElevenLabs Init Error:", err);
}

export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/media-stream" });
  console.log("🎧 Realtime-Server wartet auf Twilio-Streams...");

  wss.on("connection", (twilioWs) => {
    console.log("📞 Neue Twilio-Verbindung");

    const sessionId = uuidv4();
    let callId = null;
    let streamSid = null;
    let deepgramConnection = null;
    let conversationHistory = [];
    let isProcessing = false;

    const metrics = {
      startTime: Date.now(),
      audioChunksReceived: 0,
      audioChunksSent: 0,
      transcriptions: 0,
      responses: 0,
      errors: [],
    };

    function setupDeepgram() {
      try {
        console.log(`🎤 [${elapsed()}ms] Starte Deepgram mit Config:`, {
          model: "nova-2",
          language: "de",
          encoding: "mulaw",
          sample_rate: 8000,
          channels: 1
        });
        
        deepgramConnection = deepgram.listen.live({
          model: "nova-2",
          language: "de",
          encoding: "mulaw",
          sample_rate: 8000,
          channels: 1,
          smart_format: true,
          interim_results: false,
          endpointing: 800,
          utterance_end_ms: 800,
        });

        deepgramConnection.on("open", () => {
          console.log(`✅ [${elapsed()}ms] Deepgram verbunden`);
        });

        deepgramConnection.on("Results", async (data) => {
          try {
            console.log(`📥 [${elapsed()}ms] Deepgram Results empfangen:`, JSON.stringify(data).substring(0, 200));
            const transcript = data.channel?.alternatives?.[0]?.transcript;
            
            if (transcript && transcript.trim().length > 0) {
              metrics.transcriptions++;
              console.log(`📝 [${elapsed()}ms] Transkription:`, transcript);
              await handleUserInput(transcript);
            } else {
              console.log(`⚠️ [${elapsed()}ms] Leere Transkription`);
            }
          } catch (err) {
            console.error(`❌ [${elapsed()}ms] Deepgram Results Error:`, err.message, err.stack);
            metrics.errors.push({ time: elapsed(), error: "deepgram_results", message: err.message });
          }
        });

        deepgramConnection.on("error", (err) => {
          console.error(`❌ [${elapsed()}ms] Deepgram Error:`, err);
          console.error("Error Type:", typeof err);
          console.error("Error Keys:", Object.keys(err));
          console.error("Error String:", String(err));
          console.error("Error JSON:", JSON.stringify(err, null, 2));
          metrics.errors.push({ time: elapsed(), error: "deepgram_connection", message: String(err) });
        });

        deepgramConnection.on("close", (code, reason) => {
          console.log(`🔌 [${elapsed()}ms] Deepgram geschlossen - Code: ${code}, Reason: ${reason}`);
        });

        deepgramConnection.on("warning", (warning) => {
          console.warn(`⚠️ [${elapsed()}ms] Deepgram Warning:`, warning);
        });

        deepgramConnection.on("metadata", (metadata) => {
          console.log(`📊 [${elapsed()}ms] Deepgram Metadata:`, metadata);
        });

      } catch (err) {
        console.error(`❌ [${elapsed()}ms] Deepgram Setup Error:`, err.message, err.stack);
        metrics.errors.push({ time: elapsed(), error: "deepgram_setup", message: err.message });
      }
    }

    async function handleUserInput(userText) {
      if (isProcessing) {
        console.log(`⏸️ [${elapsed()}ms] Bereits am Verarbeiten - überspringe`);
        return;
      }

      isProcessing = true;
      console.log(`🧠 [${elapsed()}ms] Starte Groq-Verarbeitung für: "${userText}"`);

      try {
        conversationHistory.push({
          role: "user",
          content: userText,
        });

        const startTime = Date.now();
        console.log(`📤 [${elapsed()}ms] Sende Request an Groq...`);
        
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

        const groqLatency = Date.now() - startTime;
        const responseText = completion.choices[0]?.message?.content || "";

        console.log(`✅ [${elapsed()}ms] Groq Antwort (${groqLatency}ms):`, responseText);

        conversationHistory.push({
          role: "assistant",
          content: responseText,
        });

        metrics.responses++;

        if (responseText.toLowerCase().includes("termin")) {
          console.log(`📅 [${elapsed()}ms] Termin-Keyword erkannt`);
        }

        await generateSpeech(responseText);

      } catch (error) {
        console.error(`❌ [${elapsed()}ms] Groq Error:`, error.message);
        console.error("Stack:", error.stack);
        metrics.errors.push({ time: elapsed(), error: "groq", message: error.message });
      } finally {
        isProcessing = false;
      }
    }

    async function generateSpeech(text) {
      console.log(`🔊 [${elapsed()}ms] Starte TTS für: "${text.substring(0, 50)}..."`);
      const startTime = Date.now();

      try {
        console.log(`📤 [${elapsed()}ms] Sende Request an ElevenLabs...`);

        const audioStream = await elevenlabs.textToSpeech.convert(
          "pNInz6obpgDQGcFmaJgB",
          {
            text: text,
            model_id: "eleven_turbo_v2",
            output_format: "ulaw_8000"
          }
        );

        console.log(`✅ [${elapsed()}ms] ElevenLabs Stream erhalten`);

        let audioData = Buffer.alloc(0);
        let chunkCount = 0;
        
        for await (const chunk of audioStream) {
          audioData = Buffer.concat([audioData, chunk]);
          chunkCount++;
        }

        const ttsLatency = Date.now() - startTime;
        console.log(`✅ [${elapsed()}ms] TTS komplett (${ttsLatency}ms)`, {
          bytes: audioData.length,
          chunks: chunkCount
        });

        sendAudioToTwilio(audioData);

      } catch (error) {
        console.error(`❌ [${elapsed()}ms] TTS Error:`, error.message);
        console.error("Stack:", error.stack);
        metrics.errors.push({ time: elapsed(), error: "tts", message: error.message });
      }
    }

    function sendAudioToTwilio(audioBuffer) {
      try {
        console.log(`📤 [${elapsed()}ms] Sende Audio an Twilio (${audioBuffer.length} bytes)...`);
        
        const chunkSize = 160;
        let offset = 0;
        let chunks = 0;

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
          chunks++;
          offset += chunkSize;
        }

        console.log(`✅ [${elapsed()}ms] Audio gesendet (${chunks} chunks)`);
      } catch (err) {
        console.error(`❌ [${elapsed()}ms] Send Audio Error:`, err.message, err.stack);
        metrics.errors.push({ time: elapsed(), error: "send_audio", message: err.message });
      }
    }

    twilioWs.on("message", async (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.event === "start") {
          callId = `call_${Date.now()}`;
          streamSid = msg.start.streamSid;
          console.log(`📞 [${elapsed()}ms] Call Start`, { callId, streamSid });
          console.log(`📋 [${elapsed()}ms] Stream Config:`, JSON.stringify(msg.start, null, 2));
          
          setupDeepgram();

          setTimeout(() => {
            console.log(`👋 [${elapsed()}ms] Triggere Begrüßung...`);
            handleUserInput("Hallo");
          }, 1000);
        }

        if (msg.event === "media") {
          metrics.audioChunksReceived++;

          const audioPayload = Buffer.from(msg.media.payload, "base64");
          
          if (deepgramConnection && deepgramConnection.getReadyState() === 1) {
            deepgramConnection.send(audioPayload);
            
            if (metrics.audioChunksReceived === 1) {
              console.log(`✅ [${elapsed()}ms] Erstes Audio-Chunk an Deepgram gesendet (${audioPayload.length} bytes)`);
            }
          } else {
            if (metrics.audioChunksReceived === 1) {
              console.error(`❌ [${elapsed()}ms] Deepgram nicht bereit! State:`, deepgramConnection?.getReadyState());
            }
          }

          if (metrics.audioChunksReceived % 100 === 0) {
            console.log(`⬇️ [${elapsed()}ms] Audio Chunks empfangen: ${metrics.audioChunksReceived}`);
          }
        }

        if (msg.event === "stop") {
          console.log(`🛑 [${elapsed()}ms] Stream gestoppt`);
          if (deepgramConnection) {
            deepgramConnection.finish();
          }
        }

      } catch (err) {
        console.error(`❌ [${elapsed()}ms] Message Handler Error:`, err.message, err.stack);
        metrics.errors.push({ time: elapsed(), error: "message_handler", message: err.message });
      }
    });

    twilioWs.on("close", () => {
      console.log(`🔚 [${elapsed()}ms] Call Ende`);
      
      if (deepgramConnection) {
        deepgramConnection.finish();
      }

      printDebugReport();
    });

    twilioWs.on("error", (err) => {
      console.error(`❌ [${elapsed()}ms] WebSocket Error:`, err.message, err.stack);
      metrics.errors.push({ time: elapsed(), error: "websocket", message: err.message });
    });

    function elapsed() {
      return Date.now() - metrics.startTime;
    }

    function printDebugReport() {
      const duration = Date.now() - metrics.startTime;
      
      console.log("\n" + "=".repeat(60));
      console.log(`📊 DEBUG REPORT - Call ${callId}`);
      console.log("=".repeat(60));
      console.log("\n📈 METRICS:");
      console.log(`  Audio Chunks Empfangen: ${metrics.audioChunksReceived}`);
      console.log(`  Audio Chunks Gesendet: ${metrics.audioChunksSent}`);
      console.log(`  Transkriptionen: ${metrics.transcriptions}`);
      console.log(`  Responses: ${metrics.responses}`);
      console.log(`  Dauer: ${duration}ms`);
      
      if (metrics.errors.length > 0) {
        console.log("\n❌ ERRORS:");
        metrics.errors.forEach(err => {
          console.log(`  [${err.time}ms] ${err.error}: ${err.message}`);
        });
      }
      
      console.log("\n" + "=".repeat(60) + "\n");
    }
  });
}
