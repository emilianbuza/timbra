import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { createCalendarEvent } from "./calendar.js";

// === OpenAI Realtime Verbindung ===
const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// === WebSocket-Server starten ===
export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/realtime" });
  console.log("🔊 Realtime WebSocket bereit auf /realtime");

  wss.on("connection", async (ws, req) => {
    console.log("📞 Neue Twilio-Verbindung eingegangen");

    // === OpenAI Realtime Session starten ===
    const openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    // === Wenn Verbindung zu OpenAI steht ===
    openaiWs.on("open", () => {
      console.log("🧠 OpenAI-Realtime verbunden – Session aktiv");

      // Systemrolle, Stimme und Tools konfigurieren
      openaiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            // 🎙️ Stimmeinstellungen
            voice: "verse",
            voice_profile: "de_female_warm",
            modulation: {
              pitch: -0.2, // tiefer, seriöser
              rate: -0.05, // minimal langsamer
              energy: -0.1 // weichere Aussprache
            },
            gain: 0.85, // etwas leiser für Twilio-Kompression
            audio: {
              filter: { high_cut: 5500 } // entfernt metallische Höhen
            },

            // 🧭 Verhaltensbeschreibung
            instructions: `
              Du bist die freundliche, empathische Praxisassistenz der Praxis Dr. Emilian Buza.
              Sprich natürlich, ruhig und mit leichtem Lächeln in der Stimme.
              Begrüße Anrufer mit einem kurzen, herzlichen Satz – wie eine echte Person.
              Beispielbegrüßung: "Guten Tag, Praxis Dr. Emilian Buza, was kann ich für Sie tun?"
              Wenn der Anrufer einen Termin nennt, frage bei Unklarheiten freundlich nach.
              Wenn Datum und Uhrzeit klar sind, nutze das Tool 'book_appointment'.
              Beende Gespräche höflich: "Alles klar, ich trage den Termin ein. Einen schönen Tag Ihnen noch!"
            `,

            // 🧰 Tools
            tools: [
              {
                name: "book_appointment",
                type: "function",
                description: "Buche einen Arzttermin im Kalender",
                parameters: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    dateTimeStart: { type: "string" },
                    dateTimeEnd: { type: "string" }
                  },
                  required: ["name", "dateTimeStart", "dateTimeEnd"]
                }
              }
            ]
          }
        })
      );
    });

    // === Twilio → OpenAI: Audio- und Textdaten weiterleiten ===
    ws.on("message", (msg) => {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(msg);
      }
    });

    // === OpenAI → Twilio: Antworten & Funktionsaufrufe ===
    openaiWs.on("message", (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }

      try {
        const data = JSON.parse(msg.toString());

        // Textausgabe (Debug-Log)
        if (data.type === "response.output_text.delta" && data.delta) {
          console.log("💬", data.delta);
        }

        // Funktionsaufruf "book_appointment"
        if (
          data.type === "response.function_call_arguments.delta" &&
          data.delta
        ) {
          let args;
          try {
            args = JSON.parse(data.delta);
          } catch (e) {
            console.warn("⚠️ Ungültige Funktionsargumente:", data.delta);
            return;
          }

          if (args.dateTimeStart) {
            console.log("📆 Buche Termin:", args);

            createCalendarEvent({
              summary: args.name || "Patient",
              description: "Termin via Timbra AI",
              startISO: args.dateTimeStart,
              attendees: [],
            })
              .then(() => console.log("✅ Termin erfolgreich eingetragen"))
              .catch((err) =>
                console.error("❌ Fehler beim Eintragen des Termins:", err)
              );
          }
        }
      } catch {
        // kein valides JSON → ignorieren
      }
    });

    // === Verbindungstrennung behandeln ===
    ws.on("close", () => {
      console.log("🔚 Twilio getrennt");
      openaiWs.close();
    });

    openaiWs.on("close", () => console.log("🔚 OpenAI getrennt"));
  });
}
