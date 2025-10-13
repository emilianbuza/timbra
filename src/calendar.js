import { google } from "googleapis";

function getServiceAccountFromBase64() {
  const b64 = process.env.GOOGLE_SA_BASE64;
  if (!b64) throw new Error("GOOGLE_SA_BASE64 missing");
  const json = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(json);
}

let cachedAuth = null;

export function getCalendarClient() {
  if (cachedAuth) return cachedAuth;

  const creds = getServiceAccountFromBase64();
  const scopes = ["https://www.googleapis.com/auth/calendar"];
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    scopes
  );
  cachedAuth = google.calendar({ version: "v3", auth: jwt });
  return cachedAuth;
}

/**
 * Creates a 15-minute event starting at `startISO` (ISO string, Europe/Berlin by default)
 */
export async function createCalendarEvent({
  summary,
  description,
  attendees = [],
  startISO,
  timezone = process.env.TIMEZONE || "Europe/Berlin",
  calendarId = process.env.GOOGLE_CALENDAR_ID || "primary"
}) {
  const calendar = getCalendarClient();
  const start = new Date(startISO);
  const end = new Date(start.getTime() + 15 * 60 * 1000);

  const event = {
    summary,
    description,
    start: { dateTime: start.toISOString(), timeZone: timezone },
    end: { dateTime: end.toISOString(), timeZone: timezone },
    attendees
  };

  const res = await calendar.events.insert({
    calendarId,
    requestBody: event
  });

  return res.data;
}
