# Voice Khata — *Speak. Your khata updates itself.*

Voice Khata is a voice-first, on-device encrypted credit ledger Progressive Web App (PWA) built for shop owners, vendors, small traders, and household expense tracking across India.

---

## Key Capabilities

- **Push-to-Talk Voice Entry & Deterministic Parsing (`public/src/parser.js`)**: Pure local rule engine supporting English and Hinglish spoken numbers (`"three-forty"` → `340`, `"five hundred and sixty"` → `560`, `"twelve fifty"` → `1250`, `"panch sau saath"` → `560`), multi-clause entries, relative dates (`today`/`aaj`, `yesterday`/`kal`, `parso`), in-place spoken corrections (`"No, 650."`), same-name confirmation, and instant balance queries.
- **Gnani Prisma STT & Timbre TTS Proxy (`server/`)**: Node.js + Express + `ws` server keeps voice API credentials strictly server-side in `.env` and streams 16 kHz mono Int16 PCM audio, automatically falling back to native Browser Web Speech API when keys are not configured.
- **On-Device AES-GCM 256-Bit Vault (`public/src/vault.js`)**: All customers, khata entries, reports, and stock items are encrypted at rest inside IndexedDB using a non-extractable Web Crypto key, with one-tap permanent deletion.
- **Dues, Collections, Profit/Loss & Stock Tracking (`public/pnl.js`, `public/src/reports.js`)**: Pure accounting calculations, period statements, FIFO overdue ageing buckets, customer khata tables, polite share-sheet reminders, plain-SVG profit/loss graphs, and inventory tracking.
- **Multi-Language, RTL & Adaptive Themes**: English, Hindi, Kannada, Tamil, and Urdu (RTL) with Light, Dark, and System themes.

---

## Quick Start

```bash
npm install
npm start
```

- Product website: `http://localhost:3000/`
- Voice Khata app: `http://localhost:3000/app`
- Legal & support pages: `/privacy`, `/terms`, `/contact`

### Running Tests

```bash
npm test
```

Runs the i18n key-consistency check (`scripts/check-i18n.mjs`) and all unit test suites (`tests/parser.test.js`, `tests/pnl.test.js`, `tests/voice-fields.test.js`).
