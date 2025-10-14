#Timbr AI MVP

Lead → SMS in <60s → Antwortanalyse → Terminbuchung (Google Calendar)

## Setup

1) `cp .env.example .env` und alle Keys setzen
2) `npm install`
3) Start: `npm run dev`

## Endpoints

- `POST /api/new-lead`
  ```json
  {
    "name": "Alex",
    "phone": "+4915123456789",
    "service": "Webdesign"
  }

