import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { createCalendarEvent } from "./calendar.js";

// === OpenAI Realtime Verbindung ===
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Starte WebSocket-Server
export function initRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: "/realtime" });
  console.log("🔊 Realtime WebSocket bereit auf /realtime");

  wss.on("connection", async (ws, req) => {
    console.log("📞 Neue Twilio-Verbindung");

    // OpenAI Realtime Session
    const openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    openaiWs.on("open", () => {
      console.log("🧠 OpenAI-Realtime verbunden");
      // Systemrolle: Praxis Dr. Emilian Buza
      openaiWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            voice: "alloy",
            instructions: `
              Du bist die freundliche Praxisassistenz der Praxis Dr. Emilian Buza.
              Sprich in natürlichem, höflichem Deutsch.
              Wenn der Anrufer einen Termin nennt, rufe das Tool 'book_appointment' auf
              mit Datum, Uhrzeit und Name.
            `,
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

    // Weiterleiten Twilio→OpenAI
    ws.on("message", (msg) => {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(msg);
      }
    });

    // Weiterleiten OpenAI→Twilio
    openaiWs.on("message", (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }

      try {
        const data = JSON.parse(msg.toString());
        if (data.type === "response.output_text.delta") {
          console.log("💬", data.delta);
        }
        if (data.type === "response.function_call_arguments.delta" && data.delta) {
          const args = JSON.parse(data.delta);
          if (args.dateTimeStart) {
            console.log("📆 Buche Termin:", args);
            insertEvent({
              summary: args.name || "Patient",
              start: args.dateTimeStart,
              end: args.dateTimeEnd,
              description: "Termin via Timbra AI"
            }).then(() => console.log("✅ Termin eingetragen"));
          }
        }
      } catch (e) {
        // ignore
      }
    });

    ws.on("close", () => {
      console.log("🔚 Twilio getrennt");
      openaiWs.close();
    });
    openaiWs.on("close", () => console.log("🔚 OpenAI getrennt"));
  });
}

