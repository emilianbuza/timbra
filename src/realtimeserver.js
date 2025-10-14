import { WebSocketServer } from "ws";
import Groq from "groq-sdk";
import { ElevenLabsClient } from "elevenlabs";
import { v4 as uuidv4 } from "uuid";

console.log("🔍 API Key Checks:");
console.log("  GROQ:", process.env.GROQ_API_KEY ? `${process.env.GROQ_API_KEY.substring(0, 10)}... (${process.env.GROQ_API_KEY.length} chars)` : "❌ MISSING");
console.log("  ELEVENLABS:", process.env.ELEVENLABS_API_KEY ? `${process.env.ELEVENLABS_API_KEY.substring(0, 10)}... (${process.env.ELEVENLABS_API_KEY.length} chars)` : "❌ MISSING");

let groq, elevenlabs;

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
    let conversationHistory = [];
    let isProcessing = false;
    let audioBuffer = [];
    let silenceTimer = null;

    const metrics = {
      sessionId,
      startTime,
      twilioConnected: false,
      audioChunksReceived: 0,
      audioBufferSize: 0,
      audioBufferChunks: 0,
      transcriptionAttempts: 0,
      transcriptionsReceived: 0,
      emptyTranscriptions: 0,
      groqWhisperRequests: 0,
      groqWhisperResponses: 0,
      groqWhisperErrors: 0,
      groqChatRequests: 0,
      groqChatResponses: 0,
      groqChatErrors: 0,
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
        'whisper': '🎤',
        'groq': '🧠',
        'elevenlabs': '🔊',
        'twilio': '📞',
        'audio': '🔉',
        'transcript': '📝',
        'buffer': '💾'
      }[type] || '•';

      console.log(`${emoji} [${timestamp}ms] ${message}`, data ? JSON.stringify(data).substring(0, 300) : '');
    }

    async function transcribeAudio() {
      if (audioBuffer.length === 0 || isProcessing) {
        log('warning', 'Transcribe Skip', { 
          reason: audioBuffer.length === 0 ? 'empty_buffer' : 'already_processing',
          bufferChunks: audioBuffer.length 
        });
        return;
      }

      isProcessing = true;
      metrics.transcriptionAttempts++;
      
      const audioData = Buffer.concat(audioBuffer);
      const bufferChunks = audioBuffer.length;
      audioBuffer = [];
      
      log('whisper', `Transcription Attempt #${metrics.transcriptionAttempts}`, {
        audioBytes: audioData.length,
        bufferChunks: bufferChunks,
        durationSeconds: (audioData.length / 8000).toFixed(2)
      });

      try {
        log('whisper', 'Konvertiere μ-law zu WAV...');
        const wavBuffer = convertMulawToWav(audioData);
        log('success', 'WAV erstellt', { wavBytes: wavBuffer.length });

        metrics.groqWhisperRequests++;
        log('whisper', `Groq Whisper Request #${metrics.groqWhisperRequests}...`);
        
        const whisperStart = Date.now();
        const transcription = await groq.audio.transcriptions.create({
          file: new File([wavBuffer], "audio.wav", { type: "audio/wav" }),
          model: "whisper-large-v3-turbo",
          language: "de",
          response_format: "text"
        });
        
        const whisperLatency = Date.now() - whisperStart;
        metrics.groqWhisperResponses++;

        const text = typeof transcription === 'string' ? transcription.trim() : '';
        
        log('whisper', `Whisper Response #${metrics.groqWhisperResponses} (${whisperLatency}ms)`, {
          textLength: text.length,
          text: text.substring(0, 100)
        });
        
        if (text && text.length > 0) {
          metrics.transcriptionsReceived++;
          log('transcript', `Valid Transcription #${metrics.transcriptionsReceived}: "${text}"`);
          await handleUserInput(text);
        } else {
          metrics.emptyTranscriptions++;
          log('warning', `Leere Transkription (Total: ${metrics.emptyTranscriptions})`);
        }

      } catch (error) {
        metrics.groqWhisperErrors++;
        metrics.errors.push({ 
          time: Date.now() - startTime, 
          component: 'groq_whisper', 
          error: error.message,
          status: error.status,
          type: error.type
        });
        log('error', 'Whisper Error:', { 
          message: error.message,
          status: error.status,
          type: error.type,
          stack: error.stack?.substring(0, 200)
        });
      } finally {
        isProcessing = false;
        log('info', 'Processing Lock Released');
      }
    }

    function convertMulawToWav(mulawData) {
      log('info', 'μ-law → PCM Conversion...', { inputBytes: mulawData.length });
      
      const pcmData = new Int16Array(mulawData.length);
      
      for (let i = 0; i < mulawData.length; i++) {
        const mulaw = mulawData[i];
        const sign = (mulaw & 0x80) >> 7;
        const magnitude = (mulaw & 0x7F);
        let sample = magnitude << 3;
        sample += 0x84;
        sample <<= (magnitude >> 4);
        sample -= 0x84;
        if (sign === 1) sample = -sample;
        pcmData[i] = sample;
      }

      const wavHeader = Buffer.alloc(44);
      const dataLength = pcmData.length * 2;
      const fileLength = dataLength + 36;

      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(fileLength, 4);
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(1, 22);
      wavHeader.writeUInt32LE(8000, 24);
      wavHeader.writeUInt32LE(16000, 28);
      wavHeader.writeUInt16LE(2, 32);
      wavHeader.writeUInt16LE(16, 34);
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(dataLength, 40);

      log('success', 'WAV Header erstellt', { 
        sampleRate: 8000,
        channels: 1,
        bitsPerSample: 16,
        dataLength: dataLength
      });

      return Buffer.concat([wavHeader, Buffer.from(pcmData.buffer)]);
    }

    async function handleUserInput(userText) {
      metrics.groqChatRequests++;
      log('groq', `Chat Request #${metrics.groqChatRequests} für: "${userText}"`);

      try {
        conversationHistory.push({
          role: "user",
          content: userText,
        });

        log('groq', 'Sende an Groq Chat...', {
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

        metrics.groqChatResponses++;
        log('success', `Chat Response #${metrics.groqChatResponses} (${groqLatency}ms): "${responseText}"`, {
          finishReason: completion.choices[0]?.finish_reason,
          tokensUsed: completion.usage
        });

        conversationHistory.push({
          role: "assistant",
          content: responseText,
        });

        await generateSpeech(responseText);

      } catch (error) {
        metrics.groqChatErrors++;
        metrics.errors.push({ 
          time: Date.now() - startTime, 
          component: 'groq_chat', 
          error: error.message 
        });
        log('error', 'Groq Chat Error:', {
          message: error.message,
          status: error.status,
          type: error.type,
          stack: error.stack?.substring(0, 200)
        });
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
            log('audio', 'Erstes TTS-Chunk', { bytes: chunk.length });
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
        metrics.errors.push({ 
          time: Date.now() - startTime, 
          component: 'elevenlabs', 
          error: error.message 
        });
        log('error', 'ElevenLabs Error:', {
          message: error.message,
          name: error.name,
          status: error.status,
          stack: error.stack?.substring(0, 200)
        });
      }
    }

    function sendAudioToTwilio(audioBuffer) {
      log('twilio', 'Sende Audio...', {
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
          metrics.errors.push({ 
            time: Date.now() - startTime, 
            component: 'twilio_send', 
            error: err.message 
          });
          log('error', 'Twilio Send Error:', { message: err.message });
          break;
        }
      }

      log('success', `Audio gesendet: ${chunks} chunks, ${audioBuffer.length} bytes`);
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
            mediaFormat: msg.start.mediaFormat
          });

          setTimeout(() => {
            log('info', 'Triggere Begrüßung...');
            handleUserInput("Hallo");
          }, 1000);
        }

        if (msg.event === "media") {
          metrics.audioChunksReceived++;
          const audioPayload = Buffer.from(msg.media.payload, "base64");
          
          audioBuffer.push(audioPayload);
          metrics.audioBufferSize += audioPayload.length;
          metrics.audioBufferChunks = audioBuffer.length;

          if (metrics.audioChunksReceived === 1) {
            log('audio', 'Erstes Audio von Twilio', {
              bytes: audioPayload.length,
              timestamp: msg.media.timestamp
            });
          }

          if (silenceTimer) clearTimeout(silenceTimer);
          
          silenceTimer = setTimeout(() => {
            log('buffer', 'Silence detected - triggering transcription', {
              bufferChunks: audioBuffer.length,
              bufferBytes: metrics.audioBufferSize
            });
            
            if (audioBuffer.length > 40) {
              transcribeAudio();
            } else {
              log('warning', 'Buffer zu klein für Transkription', {
                chunks: audioBuffer.length,
                minRequired: 40
              });
            }
          }, 1500);

          if (metrics.audioChunksReceived % 100 === 0) {
            log('info', 'Audio Progress', {
              chunksReceived: metrics.audioChunksReceived,
              bufferChunks: audioBuffer.length,
              bufferBytes: metrics.audioBufferSize,
              transcriptions: metrics.transcriptionsReceived
            });
          }
        }

        if (msg.event === "stop") {
          log('twilio', 'Stream Stop Event');
          if (silenceTimer) clearTimeout(silenceTimer);
        }

      } catch (err) {
        metrics.errors.push({ 
          time: Date.now() - startTime, 
          component: 'message_handler', 
          error: err.message 
        });
        log('error', 'Message Handler Error:', { 
          message: err.message, 
          stack: err.stack?.substring(0, 200)
        });
      }
    });

    twilioWs.on("close", () => {
      log('twilio', 'WebSocket Closed');
      if (silenceTimer) clearTimeout(silenceTimer);
      printDebugReport();
    });

    twilioWs.on("error", (err) => {
      metrics.errors.push({ 
        time: Date.now() - startTime, 
        component: 'websocket', 
        error: err.message 
      });
      log('error', 'WebSocket Error:', { 
        message: err.message, 
        stack: err.stack?.substring(0, 200)
      });
    });

    function printDebugReport() {
      const duration = Date.now() - startTime;
      
      console.log("\n" + "=".repeat(80));
      console.log(`📊 DEBUG REPORT - Session ${sessionId.substring(0, 8)}`);
      console.log("=".repeat(80));
      
      console.log("\n🔌 CONNECTION:");
      console.log(`  Twilio: ${metrics.twilioConnected ? '✅' : '❌'}`);
      
      console.log("\n🎤 AUDIO FLOW:");
      console.log(`  Twilio → Server: ${metrics.audioChunksReceived} chunks`);
      console.log(`  Buffer Size: ${metrics.audioBufferSize} bytes`);
      console.log(`  Server → Twilio: ${metrics.audioChunksSentToTwilio} chunks (${metrics.audioBytesSentToTwilio} bytes)`);
      
      console.log("\n📝 TRANSCRIPTION:");
      console.log(`  Whisper Requests: ${metrics.groqWhisperRequests}`);
      console.log(`  Whisper Responses: ${metrics.groqWhisperResponses}`);
      console.log(`  Whisper Errors: ${metrics.groqWhisperErrors}`);
      console.log(`  Valid Transcriptions: ${metrics.transcriptionsReceived}`);
      console.log(`  Empty Transcriptions: ${metrics.emptyTranscriptions}`);
      
      console.log("\n🧠 GROQ CHAT:");
      console.log(`  Requests: ${metrics.groqChatRequests}`);
      console.log(`  Responses: ${metrics.groqChatResponses}`);
      console.log(`  Errors: ${metrics.groqChatErrors}`);
      
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
        console.log("  ⛔ KEINE Audio von Twilio!");
      }
      if (metrics.groqWhisperRequests === 0) {
        console.log("  ⛔ KEINE Whisper Requests!");
      }
      if (metrics.transcriptionsReceived === 0) {
        console.log("  ⛔ KEINE validen Transkriptionen!");
      }
      if (metrics.groqChatResponses === 0) {
        console.log("  ⛔ KEINE Chat Responses!");
      }
      if (metrics.ttsResponses === 0) {
        console.log("  ⛔ KEINE TTS Responses!");
      }
      if (metrics.audioChunksSentToTwilio === 0) {
        console.log("  ⛔ KEIN Audio an Twilio gesendet!");
      }
      
      console.log("\n" + "=".repeat(80) + "\n");
    }
  });
}
