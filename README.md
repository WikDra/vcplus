# VC+ — Przeglądarkowy klon Discorda

Kompletny klon Discorda działający w przeglądarce z kanałami głosowymi, tekstowymi, streamingiem i zaawansowanym przetwarzaniem audio.

## ✨ Funkcje

- 💬 **Kanały tekstowe** — czat w czasie rzeczywistym, markdown, wskaźnik pisania
- 🔊 **Kanały głosowe** — WebRTC peer-to-peer, mixer użytkowników
- 🎙️ **Przetwarzanie audio** — odszumianie, wycinanie stuków klawiatury, noise gate, kompresja, echo cancellation
- 🎛️ **Mixer audio** — indywidualna głośność każdego użytkownika + master
- 📺 **Streaming z przeglądarki** — udostępnianie ekranu przez WebRTC
- 🎥 **Streaming z OBS** — serwer RTMP z kluczem streamu
- 📱 **Responsywny design** — działa na telefonach i komputerach
- 👤 **System kont** — rejestracja, logowanie, profile
- 🛡️ **Panel admina** — zarządzanie użytkownikami, serwerami, statystyki
- 🏠 **Serwery (gildie)** — tworzenie, dołączanie kodem zaproszenia
- 🖥️ **Cross-platform** — działa na Windows i Linux

## 🚀 Uruchomienie

### Wymagania
- **Node.js** 18+ (https://nodejs.org/)

### Windows
```
start.bat
```

### Linux / macOS
```
chmod +x start.sh
./start.sh
```

### Ręcznie
```bash
npm install
node server/index.js
```

Serwer startuje na `http://localhost:3000`

## ⚙️ Konfiguracja

Plik `.env`:

| Zmienna | Domyślnie | Opis |
|---------|-----------|------|
| `PORT` | 3000 | Port serwera HTTP |
| `JWT_SECRET` | ... | Sekret JWT (zmień na produkcji!) |
| `RTMP_PORT` | 1935 | Port serwera RTMP (dla OBS) |
| `RTMP_HTTP_PORT` | 8888 | Port HTTP serwera RTMP |
| `ADMIN_USERNAME` | admin | Login administratora |
| `ADMIN_PASSWORD` | admin123 | Hasło administratora |

## 📺 Streaming z OBS

1. Zaloguj się na konto
2. Wejdź w **Ustawienia** → sekcja **Streaming**
3. Skopiuj swój **klucz streamu**
4. W OBS ustaw:
   - **Serwer**: `rtmp://TWOJ_ADRES:1935/live`
   - **Klucz streamu**: skopiowany klucz
5. Kliknij „Rozpocznij streaming" w OBS

## 🎙️ Przetwarzanie audio

Aplikacja oferuje zaawansowane przetwarzanie audio w przeglądarce:

- **Noise Gate** — automatycznie wycisza mikrofon gdy nie mówisz
- **Filtr klawiatury** — wykrywa i tłumi stuki klawiszy (analiza transientów + filtr notch na 2.5-4kHz)
- **Filtry pasmowe** — high-pass 80Hz (usuwanie dudnienia), low-pass 14kHz (usuwanie szumów)
- **Kompresja dynamiki** — wyrównuje głośność, działa jako limiter
- **Echo cancellation** — wbudowane w WebRTC
- **Auto Gain Control** — automatyczna regulacja wzmocnienia

Wszystkie parametry można regulować w ustawieniach.

## 🏗️ Architektura

```
vcplus/
├── server/
│   ├── index.js        — Główny serwer (Express + Socket.IO)
│   ├── database.js     — SQLite schema i połączenie
│   ├── auth.js         — JWT auth, bcrypt, middleware
│   ├── routes.js       — REST API endpoints
│   ├── socket.js       — Socket.IO events (chat, voice, streaming)
│   └── rtmp.js         — Serwer RTMP (node-media-server)
├── public/
│   ├── index.html      — SPA frontend
│   ├── css/style.css   — Discord-like dark theme
│   └── js/
│       ├── app.js              — Główna logika UI
│       ├── voice.js            — WebRTC voice engine
│       ├── streaming.js        — Streaming engine
│       └── audio-processor.js  — Audio DSP (noise gate, keyboard filter, mixer)
├── .env                — Konfiguracja
├── start.bat           — Launcher Windows
├── start.sh            — Launcher Linux
└── package.json
```

## 📡 Technologie

- **Backend**: Node.js, Express, Socket.IO, better-sqlite3
- **Głos**: WebRTC (P2P mesh), Web Audio API
- **Streaming**: RTMP (node-media-server), WebRTC screen share
- **Auth**: JWT + bcrypt
- **Baza danych**: SQLite (zero konfiguracji)
- **Frontend**: Vanilla JS, CSS Grid/Flexbox

## 🔒 Bezpieczeństwo

⚠️ **Przed uruchomieniem na produkcji:**
1. Zmień `JWT_SECRET` w `.env` na silny losowy ciąg
2. Zmień `ADMIN_PASSWORD`
3. Użyj HTTPS (np. za reverse proxy nginx)
4. Rozważ rate limiting
