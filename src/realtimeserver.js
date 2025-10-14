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
    let isSpeaking = false;
    let audioBuffer = [];
    let silenceTimer = null;
    let speechEndTimer = null;

    const MAX_BUFFER_CHUNKS = 150;
    const SILENCE_MS = 1200;
    const MIN_CHUNKS = 50;

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
      bufferOverflows: 0,
      silenceTriggers: 0,
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

    function isJunkTranscription(text) {
      const junk = [
        'vielen dank',
        'danke',
        '...',
        'oh',
        'ah',
        'mhm',
        'hm',
        'ard text',
        'untertitel',
        'im auftrag',
        'applaus'
      ];
      const lower = text.toLowerCase().trim();
      return junk.some(j => lower === j || (lower.includes(j) && text.length < 20));
    }

    async function transcribeAudio(trigger) {
      if (audioBuffer.length === 0) {
        log('warning', 'Transcribe Skip: Empty Buffer');
        return;
      }

      if (isProcessing) {
        log('warning', 'Transcribe Skip: Already Processing');
        return;
      }

      if (isSpeaking) {
        log('warning', 'Transcribe Skip: Bot is speaking');
        audioBuffer = [];
        return;
      }

      if (audioBuffer.length < MIN_CHUNKS) {
        log('warning', 'Buffer zu klein', { chunks: audioBuffer.length, min: MIN_CHUNKS });
        return;
      }

      isProcessing = true;
      metrics.transcriptionAttempts++;
      
      if (trigger === 'silence') metrics.silenceTriggers++;
      if (trigger === 'overflow') metrics.bufferOverflows++;
      
      const audioData = Buffer.concat(audioBuffer);
      const bufferChunks = audioBuffer.length;
      audioBuffer = [];
      
      log('whisper', `Transcription #${metrics.transcriptionAttempts} (${trigger})`, {
        audioBytes: audioData.length,
        bufferChunks: bufferChunks,
        durationSeconds: (audioData.length / 8000).toFixed(2)
      });

      try {
        const wavBuffer = convertMulawToWav(audioData);

        metrics.groqWhisperRequests++;
        
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
        
        log('whisper', `Whisper #${metrics.groqWhisperResponses} (${whisperLatency}ms)`, { text });
        
        if (text && text.length > 2 && !isJunkTranscription(text)) {
          metrics.transcriptionsReceived++;
          log('transcript', `Valid #${metrics.transcriptionsReceived}: "${text}"`);
          await handleUserInput(text);
        } else {
          metrics.emptyTranscriptions++;
          log('warning', `Ignoriert: "${text}"`);
        }

      } catch (error) {
        metrics.groqWhisperErrors++;
        metrics.errors.push({ 
          time: Date.now() - startTime, 
          component: 'groq_whisper', 
          error: error.message
        });
        log('error', 'Whisper Error:', { message: error.message });
      } finally {
        isProcessing = false;
      }
    }

    function convertMulawToWav(mulawData) {
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

      return Buffer.concat([wavHeader, Buffer.from(pcmData.buffer)]);
    }

    async function handleUserInput(userText) {
      metrics.groqChatRequests++;
      log('groq', `Chat #${metrics.groqChatRequests}: "${userText}"`);

      try {
        conversationHistory.push({
          role: "user",
          content: userText,
        });

        const groqStart = Date.now();
        const completion = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content: `Du bist Lea von Praxis Dr. Buza.
Begrüße: 'Guten Tag, Praxis Dr. Buza, was kann ich für Sie tun?'
Bei Terminwunsch: Frage nach Datum UND Uhrzeit.
Wenn Patient vage antwortet: Frage konkret nach Datum (z.B. "Welcher Tag passt Ihnen - Montag, Dienstag?").
Wenn Patient sich verabschiedet: Sage "Auf Wiederhören" und beende höflich.
Antworte sehr kurz (max 1-2 Sätze).`,
            },
            ...conversationHistory,
          ],
          temperature: 0.7,
          max_tokens: 100,
        });

        const groqLatency = Date.now() - groqStart;
        const responseText = completion.choices[0]?.message?.content || "";

        metrics.groqChatResponses++;
        log('success', `Chat #${metrics.groqChatResponses} (${groqLatency}ms): "${responseText}"`);

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
        log('error', 'Groq Chat Error:', { message: error.message });
      }
    }

    async function generateSpeech(text) {
      metrics.ttsRequests++;
      log('elevenlabs', `TTS #${metrics.ttsRequests}: "${text.substring(0, 50)}..."`);

      isSpeaking = true;
      audioBuffer = [];

      if (silenceTimer) clearTimeout(silenceTimer);
      if (speechEndTimer) clearTimeout(speechEndTimer);

      const ttsStart = Date.now();

      try {
        const audioStream = await elevenlabs.textToSpeech.convert(
          "pNInz6obpgDQGcFmaJgB",
          {
            text: text,
            model_id: "eleven_turbo_v2",
            output_format: "ulaw_8000"
          }
        );

        let audioData = Buffer.alloc(0);
        let chunkCount = 0;
        
        for await (const chunk of audioStream) {
          audioData = Buffer.concat([audioData, chunk]);
          chunkCount++;
        }

        const ttsLatency = Date.now() - ttsStart;
        metrics.ttsResponses++;
        
        log('success', `TTS #${metrics.ttsResponses} (${ttsLatency}ms)`, {
          totalBytes: audioData.length,
          chunks: chunkCount
        });

        sendAudioToTwilio(audioData);

        const estimatedPlaybackMs = (audioData.length / 8) + 500;
        speechEndTimer = setTimeout(() => {
          isSpeaking = false;
          audioBuffer = [];
          log('info', 'Bot finished speaking');
        }, estimatedPlaybackMs);

      } catch (error) {
        metrics.ttsErrors++;
        isSpeaking = false;
        metrics.errors.push({ 
          time: Date.now() - startTime, 
          component: 'elevenlabs', 
          error: error.message 
        });
        log('error', 'ElevenLabs Error:', { message: error.message });
      }
    }

    function sendAudioToTwilio(audioBuffer) {
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
          log('error', 'Send Error:', { message: err.message });
          break;
        }
      }

      log('success', `Sent ${chunks} chunks`);
    }

    twilioWs.on("message", async (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.event === "start") {
          callId = `call_${Date.now()}`;
          streamSid = msg.start.streamSid;
          metrics.twilioConnected = true;
          
          const tracks = msg.start.tracks || [];
          log('twilio', 'Stream Start', { callId, streamSid, tracks });
          
          if (!tracks.includes("inbound")) {
            log('warning', 'Kein inbound track!');
          }

          setTimeout(() => {
            handleUserInput("Hallo");
          }, 800);
        }

        if (msg.event === "media") {
          if (msg.media.track !== "inbound") {
            return;
          }

          metrics.audioChunksReceived++;
          const audioPayload = Buffer.from(msg.media.payload, "base64");

          if (isSpeaking) {
            return;
          }
          
          audioBuffer.push(audioPayload);
          metrics.audioBufferSize += audioPayload.length;
          metrics.audioBufferChunks = audioBuffer.length;

          if (audioBuffer.length >= MAX_BUFFER_CHUNKS && !isProcessing) {
            log('buffer', 'OVERFLOW', { chunks: audioBuffer.length });
            if (silenceTimer) clearTimeout(silenceTimer);
            transcribeAudio('overflow');
            return;
          }

          if (silenceTimer) clearTimeout(silenceTimer);
          
          silenceTimer = setTimeout(() => {
            if (!isSpeaking && audioBuffer.length >= MIN_CHUNKS) {
              transcribeAudio('silence');
            }
          }, SILENCE_MS);
        }

        if (msg.event === "stop") {
          log('twilio', 'Stream Stop');
          if (silenceTimer) clearTimeout(silenceTimer);
          if (speechEndTimer) clearTimeout(speechEndTimer);
        }

      } catch (err) {
        log('error', 'Message Error:', { message: err.message });
      }
    });

    twilioWs.on("close", () => {
      log('twilio', 'WebSocket Closed');
      if (silenceTimer) clearTimeout(silenceTimer);
      if (speechEndTimer) clearTimeout(speechEndTimer);
      printDebugReport();
    });

    twilioWs.on("error", (err) => {
      log('error', 'WebSocket Error:', { message: err.message });
    });

    function printDebugReport() {
      const duration = Date.now() - startTime;
      
      console.log("\n" + "=".repeat(80));
      console.log(`📊 DEBUG - Session ${sessionId.substring(0, 8)}`);
      console.log("=".repeat(80));
      console.log(`Duration: ${(duration/1000).toFixed(1)}s`);
      console.log(`Audio In: ${metrics.audioChunksReceived} chunks`);
      console.log(`Audio Out: ${metrics.audioChunksSentToTwilio} chunks`);
      console.log(`Transcriptions: ${metrics.transcriptionsReceived} valid, ${metrics.emptyTranscriptions} ignored`);
      console.log(`Chat: ${metrics.groqChatResponses} responses`);
      console.log(`TTS: ${metrics.ttsResponses} responses`);
      if (metrics.errors.length > 0) {
        console.log(`Errors: ${metrics.errors.length}`);
      }
      console.log("=".repeat(80) + "\n");
    }
  });
}
