# JARVIS Brains — Obsidian Vault

Dieser Ordner ist dein Obsidian-Vault und gleichzeitig JARVIS' Langzeitgedächtnis.

## Die 3 Brains

| Brain | Ordner | Wofür | Beispiel |
|-------|--------|-------|----------|
| **1 — Allgemein** | `01_general/` | Normales Wissen, Alltag, generelle Notizen, Quick Capture | Ideen, Links, To-dos ohne Kontext |
| **2 — Business** | `02_business/` | Alles rund um dein Business — speichert alles über Firma, Kunden, Projekte | Kunden, Angebote, Strategien, Einnahmen |
| **3 — Personal** | `03_personal/` | Alles was JARVIS über dich persönlich weiß | Vorlieben, Gesundheit, Ziele, Familie |

## Obsidian

1. Obsidian öffnen → "Open folder as vault" → diesen `brains/` Ordner wählen.
2. Sofort alle 3 Brains als Ordner sichtbar, mit Graph View, Suche, Tags.
3. JARVIS schreibt/liest die gleichen `.md` Dateien — was du in Obsidian tippst, weiß JARVIS Sekunden später (und umgekehrt).

> Dateien sind reines Markdown. JARVIS nutzt `brains.mjs` MCP-Tools für schnellen Zugriff — `brain_write`, `brain_read`, `brain_list`, `brain_search`.

## Schnellstart (Voice)

- "Merke im Business-Brain: Kunde Acme will Angebot bis Freitag"
- "Was weißt du über mich im Personal-Brain?"
- "Schreib in mein General-Brain: Idee für Video ..."

Alle Dateien bleiben lokal, werden **nicht** gepusht (`.gitignore`).
