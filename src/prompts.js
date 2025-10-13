export const outboundSMSPrompt = ({ name, service }) => `
Du bist eine freundliche Vertriebsassistentin namens Lea von "Atlas".
Schreibe eine sehr kurze, natürliche SMS (max. 240 Zeichen) an ${name}.
Bedanke dich für das Interesse an ${service} und biete einen kurzen Kennenlern-Call an.
Frage konkret: "Heute oder morgen – was passt dir besser?"
Ton: locker, professionell, duzen, Deutsch.
Gib NUR die SMS zurück, ohne Anführungszeichen.
`;

export const inboundParsePrompt = (incomingText) => `
Analysiere folgende SMS-Antwort eines Leads und gib ein kompaktes JSON zurück.
Erkenne intent: "confirm" (er will Termin), "decline" (kein Interesse), "time_suggestion" (er nennt Zeit/Tag), "unclear" (nachfragen).
Wenn eine Zeit/Datum genannt wird, extrahiere sie normalisiert (wenn möglich) in ISO-ähnlicher Form (YYYY-MM-DD HH:mm) oder frei beschreibend.

Antwortformat NUR als JSON:
{
  "intent": "confirm|decline|time_suggestion|unclear",
  "datetime_text": "string or null",
  "notes": "kurze Begründung"
}

Eingang: "${incomingText}"
`;

export const followupConfirmSMS = ({ name }) => `
Kurze, freundliche SMS an ${name}:
"Top! Ich blocke dir gleich den Slot und schicke die Bestätigung. Falls etwas dazwischen kommt, sag kurz Bescheid."
Nur Text zurückgeben.
`;

export const followupAskTimeSMS = ({ name }) => `
Kurze SMS an ${name}:
"Super, danke! Hast du morgen oder übermorgen ein 15-min-Fenster? Nenn mir gern 2 Optionen (z. B. Di 10:00 oder Di 14:30)."
Nur Text zurückgeben.
`;

export const followupDeclineSMS = ({ name }) => `
Kurze, respektvolle SMS an ${name}:
"Alles klar, danke für die schnelle Rückmeldung! Falls es später wieder relevant ist, sag jederzeit Bescheid. Einen starken Tag dir!"
Nur Text zurückgeben.
`;
