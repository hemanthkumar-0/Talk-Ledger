/**
 * Voice Khata — Deterministic Fixed-Rule Ledger Parser (public/src/parser.js)
 * ZERO LLM between voice and the books.
 * Pure, synchronous, zero-latency rule engine supporting English, Hindi (Roman + Devanagari),
 * Kannada (Roman + Kannada script), and Hinglish / Kanglish shopkeeper speech.
 *
 * Returns structured confidence scores, synonym-normalized CREDIT / PAYMENT actions,
 * fuzzy customer name matching with uncertainty flags, and multi-clause date resolution.
 */

const UNITS = {
  // English
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  // Hindi / Hinglish
  shunya: 0,
  ek: 1,
  teen: 3,
  char: 4,
  chaar: 4,
  panch: 5,
  paanch: 5,
  chhe: 6,
  che: 6,
  chhah: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  // Kannada / Kanglish
  sonne: 0,
  ondu: 1,
  eradu: 2,
  yeradu: 2,
  mooru: 3,
  muru: 3,
  naalku: 4,
  nalku: 4,
  naaku: 4,
  aidu: 5,
  aydu: 5,
  aaru: 6,
  aru: 6,
  elu: 7,
  yelu: 7,
  entu: 8,
  yentu: 8,
  ombattu: 9,
  ombhattu: 9,
};

const TEENS = {
  // English
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  // Hindi / Hinglish
  das: 10,
  gyarah: 11,
  barah: 12,
  terah: 13,
  chaudah: 14,
  pandrah: 15,
  solah: 16,
  satrah: 17,
  atharah: 18,
  unnis: 19,
  // Kannada / Kanglish
  hattu: 10,
  hathu: 10,
  hannondu: 11,
  hanneradu: 12,
  hadimooru: 13,
  hadimuru: 13,
  hadinaalku: 14,
  hadinalku: 14,
  hadinaidu: 15,
  hadinaydu: 15,
  hadinaaru: 16,
  hadinelu: 17,
  hadinentu: 18,
  hattombattu: 19,
};

const TENS = {
  // English
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  // Hindi / Hinglish
  bees: 20,
  tees: 30,
  chalis: 40,
  chaalis: 40,
  pachas: 50,
  pachaas: 50,
  saath: 60,
  sattar: 70,
  assi: 80,
  nabbe: 90,
  // Kannada / Kanglish
  ippattu: 20,
  ippathu: 20,
  muvattu: 30,
  moovattu: 30,
  nalavattu: 40,
  nalvattu: 40,
  aivattu: 50,
  ayvattu: 50,
  aravattu: 60,
  arvattu: 60,
  eppattu: 70,
  yeppattu: 70,
  embattu: 80,
  yembattu: 80,
  tombattu: 90,
  thombattu: 90,
};

const COMPOUND_NUMBERS = {
  // Hindi compounds
  ikkis: 21,
  bais: 22,
  pachis: 25,
  pachchees: 25,
  pachees: 25,
  paintis: 35,
  paitalis: 45,
  pachpan: 55,
  painsath: 65,
  pachhattar: 75,
  pichasi: 85,
  pichanbe: 95,
  // Kannada fused hundred words (standalone & combining forms: "ainooru" = 500, "ainoora aivattu" = 550)
  innooru: 200,
  innuru: 200,
  inooru: 200,
  innoora: 200,
  innura: 200,
  munnooru: 300,
  munnuru: 300,
  munooru: 300,
  munnoora: 300,
  munnura: 300,
  naanooru: 400,
  nanooru: 400,
  naanuru: 400,
  naanoora: 400,
  nanoora: 400,
  ainooru: 500,
  aynooru: 500,
  ainuru: 500,
  ainoora: 500,
  aynoora: 500,
  aarnooru: 600,
  arnooru: 600,
  aarnoora: 600,
  elnooru: 700,
  yelnooru: 700,
  elnoora: 700,
  entnooru: 800,
  yentnooru: 800,
  entnoora: 800,
  ombainooru: 900,
  ombhainooru: 900,
  ombainoora: 900,
};

const SCALES = {
  // English
  hundred: 100,
  thousand: 1000,
  lakh: 100000,
  lac: 100000,
  // Hindi / Hinglish
  sau: 100,
  sow: 100,
  hazaar: 1000,
  hazar: 1000,
  // Kannada / Kanglish
  nooru: 100,
  nuru: 100,
  noora: 100,
  nura: 100,
  saavira: 1000,
  savira: 1000,
  saavirada: 1000,
  savirada: 1000,
  laksha: 100000,
};

const HINDI_CONTEXT_WORDS = new Set([
  'sau',
  'sow',
  'hazaar',
  'hazar',
  'lakh',
  'lac',
  'rupaye',
  'rupaiye',
  'rupiye',
  'udhaar',
  'udhar',
  'jama',
  'diya',
  'liya',
  'baaki',
  'baki',
  'pachas',
  'pachaas',
  'saath',
  'chalis',
  'tees',
  'bees',
  'assi',
]);

/**
 * Explicit action keyword synonym map:
 * - CREDIT  -> ledger type 'credit'  (customer took goods / owes money)
 * - PAYMENT -> ledger type 'paid'    (customer paid / returned money)
 */
export const ACTION_SYNONYMS = {
  // CREDIT synonyms (English, Hindi/Hinglish, Kannada/Kanglish)
  credit: 'CREDIT',
  credited: 'CREDIT',
  udhaar: 'CREDIT',
  udhar: 'CREDIT',
  udhari: 'CREDIT',
  udhaari: 'CREDIT',
  given: 'CREDIT',
  baaki: 'CREDIT',
  baki: 'CREDIT',
  took: 'CREDIT',
  take: 'CREDIT',
  owes: 'CREDIT',
  owe: 'CREDIT',
  liya: 'CREDIT',
  liye: 'CREDIT',
  li: 'CREDIT',
  khata: 'CREDIT',
  khaata: 'CREDIT',
  debit: 'CREDIT',
  debited: 'CREDIT',
  lent: 'CREDIT',
  borrowed: 'CREDIT',
  due: 'CREDIT',
  pending: 'CREDIT',
  bill: 'CREDIT',
  tab: 'CREDIT',
  charge: 'CREDIT',
  likh: 'CREDIT',
  likho: 'CREDIT',
  saala: 'CREDIT',
  sala: 'CREDIT',
  kotte: 'CREDIT',
  kottide: 'CREDIT',
  tagondru: 'CREDIT',
  tagondu: 'CREDIT',

  // PAYMENT synonyms (English, Hindi/Hinglish, Kannada/Kanglish)
  paid: 'PAYMENT',
  payed: 'PAYMENT',
  pay: 'PAYMENT',
  gave: 'PAYMENT',
  give: 'PAYMENT',
  returned: 'PAYMENT',
  return: 'PAYMENT',
  repaid: 'PAYMENT',
  received: 'PAYMENT',
  receive: 'PAYMENT',
  jama: 'PAYMENT',
  diya: 'PAYMENT',
  diye: 'PAYMENT',
  di: 'PAYMENT',
  settled: 'PAYMENT',
  settle: 'PAYMENT',
  deposited: 'PAYMENT',
  deposit: 'PAYMENT',
  cleared: 'PAYMENT',
  clear: 'PAYMENT',
  vasool: 'PAYMENT',
  mila: 'PAYMENT',
  mile: 'PAYMENT',
  wapas: 'PAYMENT',
  vapas: 'PAYMENT',
  cash: 'PAYMENT',
  upi: 'PAYMENT',
  gpay: 'PAYMENT',
  phonepe: 'PAYMENT',
  paytm: 'PAYMENT',
  kottaru: 'PAYMENT',
  kotru: 'PAYMENT',
  kottidare: 'PAYMENT',
  bandide: 'PAYMENT',
  banditu: 'PAYMENT',
  pavati: 'PAYMENT',
};

const CREDIT_KEYWORDS = new Set(
  Object.entries(ACTION_SYNONYMS)
    .filter(([, act]) => act === 'CREDIT')
    .map(([word]) => word)
);

const PAYMENT_KEYWORDS = new Set(
  Object.entries(ACTION_SYNONYMS)
    .filter(([, act]) => act === 'PAYMENT')
    .map(([word]) => word)
);

const PRONOUNS = new Set([
  'she',
  'he',
  'they',
  'her',
  'him',
  'unhone',
  'unhon',
  'usne',
  'woh',
  'wo',
  'unka',
  'unki',
  'unke',
  'uska',
  'uski',
  'uske',
  'avaru',
  'avanu',
  'avalu',
]);

const STOP_WORDS = new Set([
  ...CREDIT_KEYWORDS,
  ...PAYMENT_KEYWORDS,
  ...PRONOUNS,
  'on',
  'for',
  'from',
  'to',
  'of',
  'by',
  'in',
  'at',
  'the',
  'a',
  'an',
  'and',
  'or',
  'aur',
  'mattu',
  'also',
  'but',
  'lekin',
  'add',
  'record',
  'enter',
  'entry',
  'put',
  'note',
  'save',
  'log',
  'rs',
  'inr',
  'rupee',
  'rupees',
  'rupaye',
  'rupaiye',
  'rupiye',
  'rupayi',
  'only',
  'today',
  'yesterday',
  'day',
  'before',
  'aaj',
  'kal',
  'parso',
  'parson',
  'ivattu',
  'evattu',
  'ninne',
  'monne',
  'ne',
  'ka',
  'ki',
  'ke',
  'ko',
  'se',
  'mein',
  'me',
  'hai',
  'hain',
  'tha',
  'thi',
  'the',
  'kiya',
  'kiye',
  'kar',
  'karo',
  'kardo',
  'do',
  'ge',
  'ige',
  'yige',
  'haaki',
  'haki',
  'bareyiri',
  'please',
  'ji',
  'garu',
  'anna',
  'sir',
  'has',
  'have',
  'had',
  'is',
  'was',
  'were',
  'back',
  'amount',
  'money',
  'payment',
  'balance',
  'total',
  'account',
]);

/**
 * Transliterates common Devanagari Hindi & Kannada script number/ledger keywords
 * into canonical Roman tokens so our single deterministic parser handles native
 * scripts seamlessly alongside Romanized Hinglish / Kanglish / English.
 */
const INDIC_SCRIPT_TOKEN_MAP = [
  // Hindi Devanagari idioms & phrases (longest first)
  [/डेढ़\s+सौ|डेढ\s+सौ/g, ' 150 '],
  [/ढाई\s+सौ/g, ' 250 '],
  [/डेढ़\s+हज[़ा]र|डेढ\s+हज[़ा]र/g, ' 1500 '],
  [/ढाई\s+हज[़ा]र/g, ' 2500 '],
  [/सवा\s+सौ/g, ' 125 '],
  [/सवा\s+हज[़ा]र/g, ' 1250 '],
  [/साढ़े\s+तीन\s+सौ|साढे\s+तीन\s+सौ/g, ' 350 '],
  [/साढ़े\s+चार\s+सौ|साढे\s+चार\s+सौ/g, ' 450 '],
  [/साढ़े\s+पा[ंँ]च\s+सौ|साढे\s+पा[ंँ]च\s+सौ/g, ' 550 '],
  // Hindi Devanagari number words
  [/हज़ार|हजार/g, ' hazaar '],
  [/लाख/g, ' lakh '],
  [/सौ/g, ' sau '],
  [/पचहत्तर/g, ' pachhattar '],
  [/पैंसठ/g, ' painsath '],
  [/पचपन/g, ' pachpan '],
  [/पैंतालीस/g, ' paitalis '],
  [/पैंतीस/g, ' paintis '],
  [/पच्चीस/g, ' pachis '],
  [/नब्बे/g, ' nabbe '],
  [/अस्सी/g, ' assi '],
  [/सत्तर/g, ' sattar '],
  [/साठ/g, ' saath '],
  [/पचास/g, ' pachas '],
  [/चालीस/g, ' chalis '],
  [/तीस/g, ' tees '],
  [/बीस/g, ' bees '],
  [/पंद्रह/g, ' pandrah '],
  [/बारह/g, ' barah '],
  [/ग्यारह/g, ' gyarah '],
  [/दस/g, ' das '],
  [/नौ/g, ' nau '],
  [/आठ/g, ' aath '],
  [/सात/g, ' saat '],
  [/छह|छे/g, ' chhe '],
  [/पांच|पाँच/g, ' paanch '],
  [/चार/g, ' char '],
  [/तीन/g, ' teen '],
  [/दो/g, ' do '],
  [/एक/g, ' ek '],
  // Hindi Devanagari action / date / filler words
  [/उधार|उधारी/g, ' udhaar '],
  [/बाकी/g, ' baaki '],
  [/लिया|लिये|लिए/g, ' liya '],
  [/जमा/g, ' jama '],
  [/वापस/g, ' wapas '],
  [/दिया|दिये|दिए/g, ' diya '],
  [/मिला|मिले/g, ' mila '],
  [/रुपये|रुपए|रुपया/g, ' rupaye '],
  [/परसों/g, ' parso '],
  [/कल/g, ' kal '],
  [/आज/g, ' aaj '],
  [/और/g, ' aur '],
  [/किया|किये|किए/g, ' kiya '],
  [/है|हैं/g, ' hai '],
  [/ने(?=\s|$)/g, ' ne '],
  [/को(?=\s|$)/g, ' ko '],
  [/का(?=\s|$)/g, ' ka '],
  [/की(?=\s|$)/g, ' ki '],
  [/के(?=\s|$)/g, ' ke '],
  [/से(?=\s|$)/g, ' se '],
  [/जी(?=\s|$)/g, ' ji '],
  [/लिखो/g, ' likho '],

  // Kannada script idioms & compound hundreds (longest first)
  [/ಒಂದೂವರೆ\s+ಸಾವಿರ/g, ' 1500 '],
  [/ಎರಡೂವರೆ\s+ಸಾವಿರ/g, ' 2500 '],
  [/ಒಂದೂವರೆ\s+ನೂರು/g, ' 150 '],
  [/ಒಂಬೈನೂರ[ುಾ]?/g, ' ombainoora '],
  [/ಎಂಟ್ನೂರ[ುಾ]?/g, ' entnoora '],
  [/ಏಳ್ನೂರ[ುಾ]?/g, ' elnoora '],
  [/ಆರ್ನೂರ[ುಾ]?/g, ' aarnoora '],
  [/ಐನೂರ[ುಾ]?/g, ' ainoora '],
  [/ನಾನೂರ[ುಾ]?/g, ' naanoora '],
  [/ಮುನ್ನೂರ[ುಾ]?/g, ' munnoora '],
  [/ಇನ್ನೂರ[ುಾ]?/g, ' innoora '],
  [/ಸಾವಿರದ|ಸಾವಿರ/g, ' saavira '],
  [/ಲಕ್ಷ/g, ' laksha '],
  [/ನೂರಾ|ನೂರು/g, ' noora '],
  [/ತೊಂಬತ್ತು/g, ' tombattu '],
  [/ಎಂಬತ್ತು/g, ' embattu '],
  [/ಎಪ್ಪತ್ತು/g, ' eppattu '],
  [/ಅರವತ್ತು/g, ' aravattu '],
  [/ಐವತ್ತು/g, ' aivattu '],
  [/ನಲವತ್ತು/g, ' nalavattu '],
  [/ಮೂವತ್ತು/g, ' muvattu '],
  [/ಇಪ್ಪತ್ತು/g, ' ippattu '],
  [/ಹದಿನೈದು/g, ' hadinaidu '],
  [/ಹನ್ನೆರಡು/g, ' hanneradu '],
  [/ಹನ್ನೊಂದು/g, ' hannondu '],
  [/ಹತ್ತು/g, ' hattu '],
  [/ಒಂಬತ್ತು/g, ' ombattu '],
  [/ಎಂಟು/g, ' entu '],
  [/ಏಳು/g, ' elu '],
  [/ಆರು/g, ' aaru '],
  [/ಐದು/g, ' aidu '],
  [/ನಾಲ್ಕು/g, ' naalku '],
  [/ಮೂರು/g, ' mooru '],
  [/ಎರಡು/g, ' eradu '],
  [/ಒಂದು/g, ' ondu '],
  // Kannada script action / date / filler words
  [/ಸಾಲ/g, ' saala '],
  [/ಬಾಕಿ/g, ' baaki '],
  [/ಜಮಾ/g, ' jama '],
  [/ಕೊಟ್ಟರು|ಕೊಟ್ರು|ಕೊಟ್ಟಿದ್ದಾರೆ/g, ' kottaru '],
  [/ಕೊಟ್ಟೆ|ಕೊಟ್ಟಿದ್ದೇನೆ/g, ' kotte '],
  [/ಬಂದಿದೆ|ಬಂದಿತು/g, ' bandide '],
  [/ತಗೊಂಡ್ರು|ತಗೊಂಡ/g, ' tagondu '],
  [/ವಾಪಸ್/g, ' wapas '],
  [/ರೂಪಾಯಿ/g, ' rupayi '],
  [/ಮೊನ್ನೆ/g, ' monne '],
  [/ನಿನ್ನೆ/g, ' ninne '],
  [/ಇವತ್ತು/g, ' ivattu '],
  [/ಮತ್ತು/g, ' mattu '],
  [/ಅವರು|ಅವನು|ಅವಳು/g, ' avaru '],
  [/ಹಾಕಿ/g, ' haki '],
];

function transliterateIndicLedgerKeywords(input) {
  let s = ` ${String(input || '')} `;
  for (const [pattern, replacement] of INDIC_SCRIPT_TOKEN_MAP) {
    // Enforce Unicode whitespace/punctuation word boundaries so keywords like
    // Kannada "ಲಕ್ಷ" (laksha) never match inside customer names like "ಲಕ್ಷ್ಮಿ" (Lakshmi).
    const bounded = new RegExp(`(?<=^|[\\s,.;:!?।])(?:${pattern.source})(?=$|[\\s,.;:!?।])`, 'gu');
    s = s.replace(bounded, replacement);
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Formats a Date into local YYYY-MM-DD ISO string.
 */
export function toLocalIsoDate(date) {
  const d = new Date(date.getTime());
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Resolves relative date words (English, Hindi, Kannada) into ISO dates.
 */
export function parseRelativeDate(text, referenceDate = new Date()) {
  const lower = text.toLowerCase();
  const base = new Date(referenceDate.getTime());
  base.setHours(12, 0, 0, 0);

  if (/\b(day\s+before\s+yesterday|parso|parson|monne)\b/.test(lower)) {
    base.setDate(base.getDate() - 2);
    return {
      dateIso: toLocalIsoDate(base),
      dateLabel: 'day before yesterday',
      dateOffset: -2,
    };
  }

  if (/\b(yesterday|kal|ninne)\b/.test(lower)) {
    base.setDate(base.getDate() - 1);
    return {
      dateIso: toLocalIsoDate(base),
      dateLabel: 'yesterday',
      dateOffset: -1,
    };
  }

  return {
    dateIso: toLocalIsoDate(base),
    dateLabel: 'today',
    dateOffset: 0,
  };
}

function isNumberToken(word, nextWord, prevWord) {
  if (!word) return false;
  if (/^\d+$/.test(word)) return true;
  if (word === 'do') {
    return Boolean(
      (nextWord && (HINDI_CONTEXT_WORDS.has(nextWord) || nextWord in SCALES)) ||
        (prevWord && prevWord in SCALES)
    );
  }
  return (
    word in UNITS ||
    word in TEENS ||
    word in TENS ||
    word in COMPOUND_NUMBERS ||
    word in SCALES
  );
}

/**
 * Evaluates a contiguous sequence of normalized number words/digits into an exact integer.
 * Handles English, Indian spoken shorthand ("three-forty" -> 340, "twelve fifty" -> 1250),
 * Hindi/Hinglish ("paanch sau saath" -> 560, "do hazaar" -> 2000),
 * and Kannada/Kanglish ("ainooru" -> 500, "noora aivattu" -> 150, "eradu saavira" -> 2000).
 */
export function evaluateNumberTokens(tokens) {
  if (!tokens || tokens.length === 0) return null;

  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
    return parseInt(tokens[0], 10);
  }

  let total = 0;
  let current = 0;
  let lastKind = null; // 'unit' | 'teen' | 'ten' | 'compound' | 'hundred' | 'scale' | 'shorthand_ten'

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === 'and' || tok === 'aur' || tok === 'mattu') continue;

    if (/^\d+$/.test(tok)) {
      const n = parseInt(tok, 10);
      if (lastKind === 'hundred' || lastKind === 'scale') {
        current += n;
      } else if (current > 0 && current < 20 && n >= 10 && n < 100) {
        current = current * 100 + n;
      } else {
        current += n;
      }
      lastKind = n >= 100 ? 'scale' : 'compound';
      continue;
    }

    if (tok in SCALES) {
      const scale = SCALES[tok];
      if (scale === 100) {
        current = (current === 0 ? 1 : current) * 100;
        lastKind = 'hundred';
      } else {
        total += (current === 0 ? 1 : current) * scale;
        current = 0;
        lastKind = 'scale';
      }
      continue;
    }

    const isDo = tok === 'do';
    if (isDo || tok in UNITS) {
      const val = isDo ? 2 : UNITS[tok];
      if (lastKind === 'ten' || lastKind === 'shorthand_ten') {
        current += val;
        lastKind = 'compound';
      } else if (lastKind === 'hundred' || lastKind === 'scale' || lastKind === null) {
        current += val;
        lastKind = 'unit';
      } else {
        current = current * 10 + val;
        lastKind = 'compound';
      }
      continue;
    }

    if (tok in TEENS) {
      const val = TEENS[tok];
      if ((lastKind === 'unit' || lastKind === 'teen') && current > 0 && current < 20) {
        current = current * 100 + val;
        lastKind = 'compound';
      } else {
        current += val;
        lastKind = 'teen';
      }
      continue;
    }

    if (tok in TENS) {
      const val = TENS[tok];
      if (
        (lastKind === 'unit' || lastKind === 'teen' || lastKind === 'ten') &&
        current > 0 &&
        current < 100
      ) {
        current = current * 100 + val;
        lastKind = 'shorthand_ten';
      } else {
        current += val;
        lastKind = 'ten';
      }
      continue;
    }

    if (tok in COMPOUND_NUMBERS) {
      const val = COMPOUND_NUMBERS[tok];
      if (val >= 100) {
        // Fused Kannada hundred word like "ainoora" (500) -> behaves like hundred so "ainoora aivattu" = 550
        current += val;
        lastKind = 'hundred';
      } else if ((lastKind === 'unit' || lastKind === 'teen') && current > 0 && current < 20) {
        current = current * 100 + val;
        lastKind = 'compound';
      } else {
        current += val;
        lastKind = 'compound';
      }
    }
  }

  const result = total + current;
  return Number.isFinite(result) && result >= 0 ? result : null;
}

/**
 * Expands idiomatic Hindi & Kannada fractional number phrases (dedh sau, dhai sau,
 * saade teen sau, paune do sau, ondu vare saavira, etc.) into exact digits.
 */
function expandRegionalIdioms(input) {
  let out = transliterateIndicLedgerKeywords(input);

  // Hindi half / quarter idioms
  out = out.replace(/\bdedh\s+(sau|sow)\b/gi, '150');
  out = out.replace(/\bdhai\s+(sau|sow)\b/gi, '250');
  out = out.replace(/\bdedh\s+(hazaar|hazar)\b/gi, '1500');
  out = out.replace(/\bdhai\s+(hazaar|hazar)\b/gi, '2500');
  out = out.replace(/\bsava\s+(sau|sow)\b/gi, '125');
  out = out.replace(/\bsava\s+(hazaar|hazar)\b/gi, '1250');
  out = out.replace(/\bpaune\s+do\s+(sau|sow)\b/gi, '175');
  out = out.replace(/\bpaune\s+do\s+(hazaar|hazar)\b/gi, '1750');

  // Kannada half idioms ("ondu vare saavira" = 1500, "eradu vare saavira" = 2500, "ondu vare nooru" = 150)
  out = out.replace(/\bondu\s*vare\s+(nooru|nuru|noora)\b/gi, '150');
  out = out.replace(/\beradu\s*vare\s+(nooru|nuru|noora)\b/gi, '250');
  out = out.replace(/\bondu\s*vare\s+(saavira|savira)\b/gi, '1500');
  out = out.replace(/\beradu\s*vare\s+(saavira|savira)\b/gi, '2500');

  // saade <unit> sau / hazaar
  out = out.replace(
    /\bsaade\s+(ek|do|teen|char|chaar|panch|paanch|chhe|che|saat|aath|nau|one|two|three|four|five|six|seven|eight|nine)\s+(sau|sow|hazaar|hazar)\b/gi,
    (_m, unitWord, scaleWord) => {
      const u = unitWord.toLowerCase() === 'do' ? 2 : UNITS[unitWord.toLowerCase()];
      const scale = SCALES[scaleWord.toLowerCase()];
      if (!u || !scale) return _m;
      return String(Math.round((u + 0.5) * scale));
    }
  );

  // "a hundred" / "a thousand"
  out = out.replace(/\ba\s+(hundred|thousand|lakh)\b/gi, 'one $1');

  return out;
}

/**
 * Normalizes spoken numbers across English, Hindi, and Kannada into digits in-place.
 */
export function normalizeSpokenNumbers(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  const { amount, matchedText } = parseSpokenAmountWithSpan(rawText);
  if (amount === null || !matchedText) return rawText;
  const expanded = expandRegionalIdioms(rawText);
  const idx = expanded.toLowerCase().indexOf(matchedText.toLowerCase());
  if (idx === -1) return expanded;
  return `${expanded.slice(0, idx)}${amount}${expanded.slice(idx + matchedText.length)}`.replace(/\s+/g, ' ').trim();
}

/**
 * Parses an exact integer amount from any spoken phrase across English, Hindi & Kannada.
 */
export function parseSpokenAmountWithSpan(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { amount: null, matchedText: '', cleanedText: '' };
  }

  const expanded = expandRegionalIdioms(rawText);

  const normalized = expanded
    .replace(/₹/g, ' ')
    .replace(/\bRs\.?\s*/gi, ' ')
    .replace(/(\d),(?=\d{2,3}\b)/g, '$1')
    .replace(/\/-/g, ' ')
    .replace(/[-–—]/g, ' ');

  // Tokenize preserving both ASCII and Unicode Indic script tokens
  const tokenRegex = /[\p{L}\p{M}\p{N}']+/gu;
  const rawTokens = [];
  let match;
  while ((match = tokenRegex.exec(normalized)) !== null) {
    rawTokens.push({
      raw: match[0],
      lower: match[0].toLowerCase().replace(/'s$/, ''),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  let bestSpan = null;

  for (let i = 0; i < rawTokens.length; i += 1) {
    const prevWord = i > 0 ? rawTokens[i - 1].lower : null;
    const nextWord = i + 1 < rawTokens.length ? rawTokens[i + 1].lower : null;
    if (!isNumberToken(rawTokens[i].lower, nextWord, prevWord)) continue;

    let j = i;
    const seq = [];
    while (j < rawTokens.length) {
      const curr = rawTokens[j].lower;
      const prev = j > 0 ? rawTokens[j - 1].lower : null;
      const next = j + 1 < rawTokens.length ? rawTokens[j + 1].lower : null;

      if (isNumberToken(curr, next, prev)) {
        seq.push(curr);
        j += 1;
        continue;
      }

      if (
        (curr === 'and' || curr === 'aur' || curr === 'mattu') &&
        j + 1 < rawTokens.length &&
        isNumberToken(
          rawTokens[j + 1].lower,
          j + 2 < rawTokens.length ? rawTokens[j + 2].lower : null,
          curr
        )
      ) {
        seq.push(curr);
        j += 1;
        continue;
      }
      break;
    }

    const value = evaluateNumberTokens(seq);
    if (value !== null && value > 0) {
      bestSpan = {
        amount: value,
        start: rawTokens[i].start,
        end: rawTokens[j - 1].end,
        matchedText: normalized.slice(rawTokens[i].start, rawTokens[j - 1].end),
      };
      break;
    }
  }

  if (!bestSpan) {
    return { amount: null, matchedText: '', cleanedText: normalized };
  }

  const cleanedText = `${normalized.slice(0, bestSpan.start)} ${normalized.slice(bestSpan.end)}`.trim();
  return {
    amount: bestSpan.amount,
    matchedText: bestSpan.matchedText,
    cleanedText,
  };
}

export function parseSpokenAmount(text) {
  return parseSpokenAmountWithSpan(text).amount;
}

/**
 * Splits multi-clause utterances without breaking compound numbers like "five hundred and sixty".
 */
export function splitIntoClauses(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  const primaryParts = rawText
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?:[.!?;\n।]+)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  const clauses = [];

  for (const part of primaryParts) {
    const protectedPart = part.replace(
      /\b(hundred|thousand|lakh|lac|sau|sow|hazaar|hazar|nooru|nuru|noora|saavira|savira)\s+(and|aur|mattu)\s+(?=(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|ek|do|teen|char|chaar|panch|paanch|chhe|che|saat|aath|nau|das|bees|tees|chalis|pachas|saath|sattar|assi|nabbe|ondu|eradu|mooru|naalku|aidu|aaru|elu|entu|ombattu|hattu|ippattu|muvattu|nalavattu|aivattu|aravattu|eppattu|embattu|tombattu|\d+)\b)/gi,
      '$1 __NUM_AND__ '
    );

    const splitCandidates = protectedPart
      .split(
        /\s+(?:and|aur|mattu|also|but|lekin)\s+|,\s+(?=(?:she|he|they|unhone|usne|woh|wo|avaru|paid|gave|took|credit|given|received|returned|yesterday|today|kal|aaj|ninne|ivattu|[A-Z]))/i
      )
      .map((s) => s.replace(/__NUM_AND__/g, 'and'));

    if (splitCandidates.length > 1) {
      const merged = [];
      for (const frag of splitCandidates) {
        const trimmed = frag.trim();
        if (!trimmed) continue;
        if (merged.length === 0) {
          merged.push(trimmed);
        } else {
          const prevHasAmount = parseSpokenAmount(merged[merged.length - 1]) !== null;
          const currHasAmount = parseSpokenAmount(trimmed) !== null;
          if (prevHasAmount && currHasAmount) {
            merged.push(trimmed);
          } else {
            merged[merged.length - 1] = `${merged[merged.length - 1]} and ${trimmed}`;
          }
        }
      }
      clauses.push(...merged);
    } else {
      clauses.push(part);
    }
  }

  return clauses;
}

/**
 * Detects normalized action ('CREDIT' | 'PAYMENT') and ledger type ('credit' | 'paid'),
 * plus whether an explicit action keyword was found (used in confidence scoring).
 */
export function detectDirectionInfo(text) {
  const expanded = transliterateIndicLedgerKeywords(text);
  const tokens = expanded
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let creditScore = 0;
  let paidScore = 0;

  for (const tok of tokens) {
    const mapped = ACTION_SYNONYMS[tok];
    if (mapped === 'CREDIT') creditScore += 1;
    else if (mapped === 'PAYMENT') paidScore += 1;
  }

  if (/\bon\s+credit\b/i.test(expanded) || /\budhaar\s+liya\b/i.test(expanded) || /\bsaala\s+kotte\b/i.test(expanded)) {
    creditScore += 2;
  }
  if (
    /\bpaid\s+back\b/i.test(expanded) ||
    /\bjama\s+kiya\b/i.test(expanded) ||
    /\bwapas\s+(diya|kiya)\b/i.test(expanded)
  ) {
    paidScore += 2;
  }

  const explicit = creditScore > 0 || paidScore > 0;
  if (paidScore > creditScore) {
    return { type: 'paid', action: 'PAYMENT', explicit };
  }
  return { type: 'credit', action: 'CREDIT', explicit };
}

export function detectDirection(text) {
  return detectDirectionInfo(text).type;
}

function toTitleCase(name) {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (/^[A-Za-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
    .join(' ');
}

function hasPronounSubject(text) {
  const expanded = transliterateIndicLedgerKeywords(text);
  const words = expanded
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.some((w) => PRONOUNS.has(w));
}

/**
 * Extracts customer name from a clause (supports Latin, Devanagari & Kannada scripts)
 * after removing amount, date, action, and filler stop words.
 */
function extractCustomerName(cleanedWithoutAmount) {
  const cleaned = cleanedWithoutAmount
    .replace(/'s\b/gi, '')
    .replace(/[^\p{L}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  const words = cleaned.split(' ').filter((w) => {
    const low = w.toLowerCase();
    if (low.length <= 1) return false;
    if (STOP_WORDS.has(low)) return false;
    if (low in UNITS || low in TEENS || low in TENS || low in SCALES || low in COMPOUND_NUMBERS) {
      return false;
    }
    return true;
  });

  if (words.length === 0) return null;
  return toTitleCase(words.slice(0, 3).join(' '));
}

function boundedEditDistance(a, b, maxDist = 2) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > maxDist) return maxDist + 1;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Indian-name phonetic skeleton normalizer for matching STT spelling variants
 * (e.g., "Suneeta" <-> "Sunita", "Prashant" <-> "Prashanth", "Vikas" <-> "Wikas", "Shankar" <-> "Sankar").
 */
function indianPhoneticKey(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/ph/g, 'f')
    .replace(/sh/g, 's')
    .replace(/bh/g, 'b')
    .replace(/dh/g, 'd')
    .replace(/th/g, 't')
    .replace(/kh/g, 'k')
    .replace(/gh/g, 'g')
    .replace(/chh/g, 'ch')
    .replace(/w/g, 'v')
    .replace(/ee|ei|ie|y/g, 'i')
    .replace(/oo|ou/g, 'u')
    .replace(/aa/g, 'a')
    .replace(/(.)\1+/g, '$1');
}

/**
 * Resolves a spoken customer name against existing customers with exact, prefix,
 * phonetic, and Levenshtein fuzzy matching, flagging uncertain matches for user confirmation.
 */
export function resolveCustomerName(spokenName, existingCustomers = []) {
  if (!spokenName) {
    return {
      status: 'missing',
      name: null,
      spokenName: null,
      candidates: [],
      matchType: 'missing',
      matchConfidence: 0,
      uncertainMatch: true,
    };
  }

  const normalizedNames = existingCustomers
    .map((c) => (typeof c === 'string' ? c : c?.name))
    .filter(Boolean);
  const uniqueNames = Array.from(new Set(normalizedNames));

  const query = spokenName.trim().toLowerCase();
  const titleSpoken = toTitleCase(spokenName);

  // 1. Exact case-insensitive match
  const exact = uniqueNames.find((n) => n.toLowerCase() === query);
  if (exact) {
    return {
      status: 'resolved',
      name: exact,
      spokenName: titleSpoken,
      candidates: [exact],
      matchType: 'exact',
      matchConfidence: 1.0,
      uncertainMatch: false,
      fuzzy: false,
    };
  }

  // 2. First-name or token-prefix matches
  const matches = uniqueNames.filter((full) => {
    const parts = full.toLowerCase().split(/\s+/);
    return parts[0] === query || full.toLowerCase().startsWith(`${query} `);
  });

  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      name: titleSpoken,
      spokenName: titleSpoken,
      candidates: matches,
      matchType: 'ambiguous',
      matchConfidence: 0.45,
      uncertainMatch: true,
      fuzzy: false,
    };
  }

  if (matches.length === 1) {
    return {
      status: 'resolved',
      name: matches[0],
      spokenName: titleSpoken,
      candidates: matches,
      matchType: 'prefix',
      matchConfidence: 0.94,
      uncertainMatch: false,
      fuzzy: false,
    };
  }

  // 3. Phonetic + Levenshtein fuzzy match against existing customers (length >= 5)
  if (query.length >= 5 && uniqueNames.length > 0) {
    const qPhon = indianPhoneticKey(query);
    const maxDist = query.length >= 6 ? 2 : 1;

    const fuzzyScored = uniqueNames
      .map((full) => {
        const lowerFull = full.toLowerCase();
        const firstToken = lowerFull.split(/\s+/)[0] || lowerFull;
        const fullPhon = indianPhoneticKey(lowerFull);
        const firstPhon = indianPhoneticKey(firstToken);

        // Phonetic exact match (e.g. "Suneeta" -> "Sunita", "Prashanth" -> "Prashant")
        if (qPhon === fullPhon || (!query.includes(' ') && qPhon === firstPhon)) {
          return { name: full, dist: 0.5, phoneticExact: true };
        }

        if (lowerFull[0] !== query[0] && fullPhon[0] !== qPhon[0]) return null;

        const dFull = boundedEditDistance(query, lowerFull, maxDist);
        const dFirst =
          !query.includes(' ') && firstToken.length >= 5
            ? boundedEditDistance(query, firstToken, maxDist)
            : maxDist + 1;
        const dPhon = boundedEditDistance(qPhon, firstPhon, 1);

        const best = Math.min(dFull, dFirst, dPhon === 1 && firstToken.length >= 5 ? 1.2 : maxDist + 1);
        return best <= maxDist ? { name: full, dist: best, phoneticExact: false } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.dist - b.dist);

    if (fuzzyScored.length === 1) {
      const top = fuzzyScored[0];
      const matchConfidence = top.phoneticExact ? 0.82 : top.dist <= 1 ? 0.74 : 0.62;
      return {
        status: 'resolved',
        name: top.name,
        spokenName: titleSpoken,
        candidates: [top.name],
        matchType: 'fuzzy',
        matchConfidence,
        uncertainMatch: true,
        fuzzy: true,
      };
    }

    if (fuzzyScored.length > 1) {
      if (fuzzyScored[0].dist < fuzzyScored[1].dist) {
        const top = fuzzyScored[0];
        const matchConfidence = top.phoneticExact ? 0.84 : top.dist <= 1 ? 0.72 : 0.58;
        return {
          status: 'resolved',
          name: top.name,
          spokenName: titleSpoken,
          candidates: fuzzyScored.slice(0, 3).map((x) => x.name),
          matchType: 'fuzzy',
          matchConfidence,
          uncertainMatch: true,
          fuzzy: true,
        };
      }
      const tied = fuzzyScored.filter((x) => x.dist === fuzzyScored[0].dist).map((x) => x.name);
      return {
        status: 'ambiguous',
        name: titleSpoken,
        spokenName: titleSpoken,
        candidates: tied,
        matchType: 'ambiguous',
        matchConfidence: 0.45,
        uncertainMatch: true,
        fuzzy: true,
      };
    }
  }

  return {
    status: 'new',
    name: titleSpoken,
    spokenName: titleSpoken,
    candidates: [],
    matchType: 'new',
    matchConfidence: 0.88,
    uncertainMatch: false,
    fuzzy: false,
  };
}

export function buildDisambiguationPrompt(baseName, candidates) {
  if (candidates.length === 2) {
    return `Which ${baseName}? ${candidates[0]} or ${candidates[1]}?`;
  }
  const head = candidates.slice(0, -1).join(', ');
  const tail = candidates[candidates.length - 1];
  return `Which ${baseName}? ${head}, or ${tail}?`;
}

export function buildEntriesReply(entries, { pendingConfirm = false } = {}) {
  if (!entries || entries.length === 0) {
    return 'I did not catch an amount. Please say the customer name and amount.';
  }

  const suffix = pendingConfirm ? 'Please confirm.' : 'Saved.';

  if (entries.length === 1) {
    const e = entries[0];
    return `${e.customerName}, ${e.amount} ${e.type} ${e.dateLabel}. ${suffix}`;
  }

  const firstCustomer = entries[0].customerName;
  const sameCustomer = entries.every((e) => e.customerName === firstCustomer);

  if (sameCustomer) {
    const summaryParts = entries.map((e) => `${e.amount} ${e.type} ${e.dateLabel}`);
    return `${firstCustomer}: ${summaryParts.join(', ')}. ${suffix}`;
  }

  const parts = entries.map((e) => `${e.customerName} ${e.amount} ${e.type}`);
  return `${pendingConfirm ? 'Confirm' : 'Saved'} ${entries.length} entries: ${parts.join(', ')}.`;
}

export function buildBalanceReply(customerName, balance) {
  if (balance === 0) {
    return `${customerName}'s account is settled.`;
  }
  if (balance > 0) {
    return `${customerName} owes ${balance}.`;
  }
  return `${customerName} has an advance balance of ${Math.abs(balance)}.`;
}

export function buildDailySummaryReply(creditTotal, paidTotal) {
  return `Today's total: ${creditTotal} credit given and ${paidTotal} received.`;
}

function isDigitAnagramOrClose(a, b) {
  const sa = String(a).split('').sort().join('');
  const sb = String(b).split('').sort().join('');
  return sa === sb && a !== b;
}

export function selectEntryToCorrect(entries, correction, lastBatchIds = []) {
  if (!entries || entries.length === 0) return null;

  const batchEntries =
    lastBatchIds && lastBatchIds.length > 0
      ? entries.filter((e) => lastBatchIds.includes(e.id))
      : [];

  const pool = batchEntries.length > 0 ? batchEntries : [entries[entries.length - 1]];

  let filtered = pool;
  if (correction.customerName) {
    const byName = entries.filter(
      (e) => e.customerName.toLowerCase() === correction.customerName.toLowerCase()
    );
    if (byName.length > 0) filtered = byName;
  }
  if (correction.type) {
    const byType = filtered.filter((e) => e.type === correction.type);
    if (byType.length > 0) filtered = byType;
  }

  if (filtered.length === 1) return filtered[0];

  const anagramMatch = filtered.find((e) => isDigitAnagramOrClose(e.amount, correction.amount));
  if (anagramMatch) return anagramMatch;

  const todayCredit = filtered.find((e) => e.dateOffset === 0 && e.type === 'credit');
  if (todayCredit) return todayCredit;

  return filtered[filtered.length - 1];
}

function tryResolveDisambiguation(rawText, pending) {
  const lower = rawText.toLowerCase().trim();
  if (/^(cancel|stop|never\s*mind|chhodo|nahi)$/i.test(lower)) {
    return { intent: 'disambiguation_cancel', reply: 'Cancelled. Nothing was saved.', confidence: 1 };
  }

  const candidates = pending.candidates || [];
  if (candidates.length === 0) return null;

  if (/\b(first|1st|one|1|pehla|pehle)\b/.test(lower) && candidates[0]) {
    return {
      intent: 'disambiguation_resolved',
      selectedCustomer: candidates[0],
      pending,
      confidence: 0.96,
    };
  }
  if (/\b(second|2nd|two|2|doosra|dusra)\b/.test(lower) && candidates[1]) {
    return {
      intent: 'disambiguation_resolved',
      selectedCustomer: candidates[1],
      pending,
      confidence: 0.96,
    };
  }

  const tokens = lower.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const scored = candidates
    .map((candidate) => {
      const cLower = candidate.toLowerCase();
      if (lower.includes(cLower)) return { candidate, score: 100 };
      const cParts = cLower.split(/\s+/);
      const lastPart = cParts[cParts.length - 1];
      if (lastPart && tokens.includes(lastPart) && lastPart !== pending.baseName?.toLowerCase()) {
        return { candidate, score: 80 };
      }
      return { candidate, score: 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
    return {
      intent: 'disambiguation_resolved',
      selectedCustomer: scored[0].candidate,
      pending,
      confidence: 0.95,
    };
  }

  return null;
}

function parseCorrectionUtterance(rawText) {
  const trimmed = rawText.trim();
  const correctionLead =
    /^(?:no|nope|sorry|wait|actually|nahi|nahin|galat|galti|make\s+it|change\s+(?:it\s+)?to|correct(?:\s+it)?\s+to|i\s+meant|meant)\b/i;

  if (!correctionLead.test(trimmed)) return null;

  const { amount, cleanedText } = parseSpokenAmountWithSpan(trimmed);
  if (amount === null) return null;

  const dir = detectDirectionInfo(trimmed);
  const explicitType = dir.explicit ? dir.type : null;

  const strippedLead = cleanedText.replace(
    /\b(no|nope|sorry|wait|actually|nahi|nahin|galat|galti|make|it|change|correct|meant|i|to|karo|kardo)\b/gi,
    ' '
  );
  const customerName = extractCustomerName(strippedLead);

  return {
    intent: 'correction',
    amount,
    type: explicitType,
    customerName,
    confidence: 0.9,
    raw: trimmed,
  };
}

function parseDailySummaryQuery(rawText, referenceDate) {
  const lower = rawText.toLowerCase().trim();
  const isDaily =
    /\b(today'?s?\s+(total|summary|balance|book|hisab|hisaab|credit|collection)|total\s+(for\s+)?today|aaj\s+ka\s+(total|hisab|hisaab)|daily\s+(total|summary)|how\s+much\s+today)\b/.test(
      lower
    );

  if (!isDaily) return null;

  const { dateIso, dateLabel } = parseRelativeDate('today', referenceDate);
  return {
    intent: 'daily_summary_query',
    dateIso,
    dateLabel,
    confidence: 0.96,
    raw: rawText.trim(),
  };
}

function parseBalanceQuery(rawText, customers = []) {
  const trimmed = rawText.trim();
  const patterns = [
    /(?:what(?:'s|\s+is)\s+)([\p{L}][\p{L}\s]{0,30}?)(?:'s)?\s+(?:total|balance|due|credit|owes|pending|account|hisab|hisaab)\b/iu,
    /how\s+much\s+(?:does\s+|is\s+)?([\p{L}][\p{L}\s]{0,30}?)\s+(?:owe|owes|baaki|baki|due|pending)\b/iu,
    /([\p{L}][\p{L}\s]{0,30}?)\s+ka\s+(?:total|hisab|hisaab|baaki|baki|balance|udhaar|udhar)\b/iu,
    /(?:check|show|tell(?:\s+me)?|get)\s+([\p{L}][\p{L}\s]{0,30}?)(?:'s)?\s+(?:total|balance|account|due)\b/iu,
    /^([\p{L}][\p{L}\s]{0,24}?)(?:'s)?\s+(?:total|balance|hisab|hisaab)\??$/iu,
  ];

  for (const regex of patterns) {
    const m = trimmed.match(regex);
    if (m && m[1]) {
      const candidateName = m[1]
        .replace(/\b(the|for|of|mr|mrs|ms|shri)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!candidateName || /^(today|todays|daily|aaj)$/i.test(candidateName)) {
        continue;
      }

      const resolved = resolveCustomerName(candidateName, customers);
      if (resolved.status === 'ambiguous') {
        return {
          intent: 'disambiguation_required',
          forIntent: 'balance_query',
          baseName: resolved.name,
          candidates: resolved.candidates,
          reply: buildDisambiguationPrompt(resolved.name, resolved.candidates),
          confidence: 0.45,
          raw: trimmed,
        };
      }

      return {
        intent: 'balance_query',
        customerName: resolved.name,
        confidence: resolved.matchConfidence,
        raw: trimmed,
      };
    }
  }

  return null;
}

/**
 * Normalizes raw Speech-to-Text output across English, Hindi, Kannada, Tamil & Urdu:
 * - Converts Indic script digits to ASCII 0-9.
 * - Transliterates Devanagari & Kannada number/action keywords cleanly.
 * - Strips conversational filler prefixes and repairs common STT homophones.
 */
export function normalizeVoiceTranscript(rawText) {
  let s = String(rawText || '').trim();
  if (!s) return '';

  const digitBases = [0x0966, 0x0ce6, 0x0be6, 0x0660, 0x06f0];
  s = s.replace(/[\u0966-\u096F\u0CE6-\u0CEF\u0BE6-\u0BEF\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
    const code = ch.charCodeAt(0);
    for (const base of digitBases) {
      if (code >= base && code <= base + 9) return String(code - base);
    }
    return ch;
  });

  // Clean currency wrappers and Indian "/-" shorthand
  s = s
    .replace(/\b(?:rs\.?|inr)\s*(\d)/gi, '$1')
    .replace(/₹\s*(\d)/g, '$1')
    .replace(/(\d)\s*\/-(?!\d)/g, '$1')
    .replace(/\b(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:only|bucks)\b/gi, '$1');

  // Repair STT split-digit sequences like "5 60" -> "560" or "1 200" -> "1200"
  s = s.replace(/\b([1-9])\s+(\d{2,3})\b/g, '$1$2');

  // Strip polite spoken command prefixes so customer name extraction stays clean
  s = s.replace(
    /^(?:please\s+)?(?:add(?:\s+(?:an?\s+)?entry(?:\s+for)?)?|record(?:\s+(?:an?\s+)?entry(?:\s+for)?)?|note(?:\s+down)?|write(?:\s+down)?|entry\s+for|put\s+in|khata\s+mein\s+likho|likho)\s+/i,
    ''
  );

  // Repair frequent Indian-English / Hinglish Web Speech homophones
  s = s
    .replace(/\b(?:credited|kredit|credit\s+it|udhari|udhaari)\b/gi, 'credit')
    .replace(/\b(?:payed|repaid|paid\s+back|pay\s+back|jama\s+kiya|de\s+diya|wapas\s+kiya|wapas\s+diya)\b/gi, 'paid');

  // "created" is a common Chrome en-IN mishearing of "credit" when next to a number
  if (/\d/.test(s) && /\bcreated\b/i.test(s)) {
    s = s.replace(/\bcreated\b/gi, 'credit');
  }

  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Evaluates N-best Web Speech / Gnani alternatives against the deterministic ledger parser
 * and returns the highest-scoring valid ledger interpretation.
 */
export function pickBestTranscriptAlternative(alternatives = [], context = {}) {
  const cleanList = (Array.isArray(alternatives) ? alternatives : [])
    .map((item, idx) =>
      typeof item === 'string'
        ? { transcript: item, confidence: idx === 0 ? 0.85 : 0.65, idx }
        : {
            transcript: String(item?.transcript || '').trim(),
            confidence: Number(item?.confidence || (idx === 0 ? 0.85 : 0.65)),
            idx,
          }
    )
    .filter((a) => a.transcript);

  if (cleanList.length === 0) {
    return { transcript: '', confidence: 0, parsed: parseUtterance('', context) };
  }

  const knownSet = new Set(
    (context.customers || [])
      .map((c) => (typeof c === 'string' ? c : c?.name))
      .filter(Boolean)
      .map((n) => n.toLowerCase())
  );

  let best = null;
  for (const cand of cleanList) {
    const normalized = normalizeVoiceTranscript(cand.transcript);
    const parsed = parseUtterance(cand.transcript, {
      ...context,
      sttConfidence: cand.confidence,
    });
    let score = cand.confidence * 15 - cand.idx * 1.5;

    const dirInfo = detectDirectionInfo(normalized);
    if (dirInfo.explicit) score += 28;

    if (parsed.intent === 'ledger_entries') {
      const entries = parsed.entries || [];
      const exactKnown = entries.some((e) => {
        const lower = String(e.customerName || '').toLowerCase();
        return knownSet.has(lower) && normalized.toLowerCase().includes(lower);
      });
      const matchesKnown = entries.some((e) =>
        knownSet.has(String(e.customerName || '').toLowerCase())
      );
      score += exactKnown ? 145 : matchesKnown ? 115 : 95;
      score += Math.min(20, entries.length * 8);
    } else if (
      parsed.intent === 'correction' ||
      parsed.intent === 'balance_query' ||
      parsed.intent === 'daily_summary_query' ||
      parsed.intent === 'disambiguation_resolved'
    ) {
      score += 105;
    } else if (parsed.intent === 'disambiguation_required') {
      score += 90;
    } else if (parsed.intent === 'greeting') {
      score += 40;
    }

    if (!best || score > best.score) {
      best = { transcript: cand.transcript, confidence: cand.confidence, parsed, score };
    }
  }

  return best;
}

/**
 * Computes deterministic entry confidence (0..1) and human-readable warnings.
 */
function computeEntryConfidence({ sttConfidence, resolution, directionExplicit, amount, inheritedCustomer }) {
  const baseStt = Number.isFinite(Number(sttConfidence)) ? Math.max(0.25, Math.min(1, Number(sttConfidence))) : 0.94;
  const warnings = [];
  let score = baseStt;

  const matchConf = inheritedCustomer ? 0.94 : resolution.matchConfidence ?? 0.85;
  score = score * 0.55 + matchConf * 0.45;

  if (!directionExplicit) {
    score -= 0.16;
    warnings.push('No action word heard — defaulted to CREDIT. Please verify.');
  }

  if (resolution?.fuzzy && resolution?.uncertainMatch) {
    warnings.push(`Matched "${resolution.spokenName}" to existing customer "${resolution.name}" — please confirm.`);
  }

  const lowStt = baseStt < 0.72;
  if (lowStt) {
    score = Math.min(score, baseStt + 0.16);
    warnings.push('Speech recognition confidence was low — please double-check the name and amount.');
  }

  if (amount > 500000) {
    score -= 0.12;
    warnings.push('Unusually large amount — please verify digits before saving.');
  }

  const clamped = Number(Math.max(0.1, Math.min(0.99, score)).toFixed(2));
  const lowConfidence = clamped < 0.78 || lowStt || Boolean(resolution?.uncertainMatch) || !directionExplicit;
  return { confidence: clamped, lowConfidence, warnings };
}

/**
 * Main deterministic entry point.
 * Parses English, Hindi, Kannada, and Hinglish/Kanglish utterances into structured ledger entries
 * with per-entry confidence scores, synonym-normalized actions, and fuzzy-match metadata.
 */
export function parseUtterance(rawText, context = {}) {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const trimmed = normalizeVoiceTranscript(rawText);
  const referenceDate = context.referenceDate ? new Date(context.referenceDate) : new Date();
  const customers = context.customers || [];
  const sttConfidence = context.sttConfidence ?? 0.95;

  const finalize = (result) => {
    const endedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      ...result,
      parseMs: Math.max(0.1, Number((endedAt - startedAt).toFixed(2))),
    };
  };

  if (!trimmed) {
    return finalize({
      intent: 'unknown',
      confidence: 0,
      lowConfidence: true,
      warnings: ['Empty transcript'],
      reply: 'Please hold the mic and say a customer name and amount.',
      raw: '',
    });
  }

  // 0. Active disambiguation resolution
  if (context.pendingDisambiguation) {
    const resolved = tryResolveDisambiguation(trimmed, context.pendingDisambiguation);
    if (resolved) {
      return finalize(resolved);
    }
  }

  // 1. Standalone greeting
  if (/^(hello|hi|hey|namaste|namaskar|namaskara|good\s+(morning|afternoon|evening))[\s!.,?]*$/i.test(trimmed)) {
    return finalize({
      intent: 'greeting',
      confidence: 0.98,
      lowConfidence: false,
      warnings: [],
      reply: 'Hello, I am an AI assistant for your credit book.',
      raw: trimmed,
    });
  }

  // 2. Daily summary query
  const dailyQuery = parseDailySummaryQuery(trimmed, referenceDate);
  if (dailyQuery) {
    return finalize(dailyQuery);
  }

  // 3. Customer balance query
  const balanceQuery = parseBalanceQuery(trimmed, customers);
  if (balanceQuery) {
    return finalize(balanceQuery);
  }

  // 4. Spoken correction ("No, 650.", "Sorry, 650", "Make it 650", "Nahi, 650")
  const correction = parseCorrectionUtterance(trimmed);
  if (correction) {
    return finalize(correction);
  }

  // 5. Multi-clause credit & payment entries
  const clauses = splitIntoClauses(trimmed);
  const parsedEntries = [];
  let activeCustomer = context.lastCustomerName || null;
  let pendingAmbiguity = null;

  for (const clause of clauses) {
    const { amount, cleanedText } = parseSpokenAmountWithSpan(clause);
    if (amount === null) continue;

    const dirInfo = detectDirectionInfo(clause);
    const { dateIso, dateLabel, dateOffset } = parseRelativeDate(clause, referenceDate);
    const usesPronoun = hasPronounSubject(clause);
    const extractedName = extractCustomerName(cleanedText);

    let finalCustomer = null;
    let resolution = null;
    let inheritedCustomer = false;

    if (extractedName) {
      resolution = resolveCustomerName(extractedName, customers);
      if (resolution.status === 'ambiguous') {
        pendingAmbiguity = {
          baseName: resolution.name,
          candidates: resolution.candidates,
        };
        finalCustomer = resolution.name;
      } else {
        finalCustomer = resolution.name;
      }
      activeCustomer = finalCustomer;
    } else if ((usesPronoun || parsedEntries.length > 0) && activeCustomer) {
      finalCustomer = activeCustomer;
      inheritedCustomer = true;
      resolution = {
        status: 'resolved',
        name: finalCustomer,
        spokenName: finalCustomer,
        matchType: 'pronoun',
        matchConfidence: 0.94,
        uncertainMatch: false,
        fuzzy: false,
        candidates: [finalCustomer],
      };
    } else if (activeCustomer) {
      finalCustomer = activeCustomer;
      inheritedCustomer = true;
      resolution = {
        status: 'resolved',
        name: finalCustomer,
        spokenName: finalCustomer,
        matchType: 'context',
        matchConfidence: 0.82,
        uncertainMatch: true,
        fuzzy: false,
        candidates: [finalCustomer],
      };
    }

    if (!finalCustomer) continue;

    const confMeta = computeEntryConfidence({
      sttConfidence,
      resolution,
      directionExplicit: dirInfo.explicit,
      amount,
      inheritedCustomer,
    });

    parsedEntries.push({
      customerName: finalCustomer,
      spokenName: resolution?.spokenName || finalCustomer,
      matchType: resolution?.matchType || 'new',
      uncertainMatch: Boolean(resolution?.uncertainMatch),
      matchCandidates: resolution?.candidates || [],
      amount,
      signedAmount: dirInfo.type === 'credit' ? amount : -amount,
      type: dirInfo.type,
      action: dirInfo.action, // 'CREDIT' | 'PAYMENT'
      directionExplicit: dirInfo.explicit,
      confidence: confMeta.confidence,
      lowConfidence: confMeta.lowConfidence,
      warnings: confMeta.warnings,
      dateIso,
      dateLabel,
      dateOffset,
      sourceClause: clause,
    });
  }

  if (parsedEntries.length === 0) {
    return finalize({
      intent: 'unknown',
      confidence: 0,
      lowConfidence: true,
      warnings: ['No customer name or amount found'],
      reply: 'I did not catch a customer name and amount. Try saying: Kavita, 560 on credit.',
      raw: trimmed,
    });
  }

  if (pendingAmbiguity) {
    return finalize({
      intent: 'disambiguation_required',
      forIntent: 'ledger_entries',
      baseName: pendingAmbiguity.baseName,
      candidates: pendingAmbiguity.candidates,
      pendingEntries: parsedEntries,
      confidence: 0.45,
      lowConfidence: true,
      warnings: [`Multiple customers match "${pendingAmbiguity.baseName}"`],
      reply: buildDisambiguationPrompt(pendingAmbiguity.baseName, pendingAmbiguity.candidates),
      raw: trimmed,
    });
  }

  const overallConfidence = Number(
    Math.min(...parsedEntries.map((e) => e.confidence)).toFixed(2)
  );
  const lowConfidence = parsedEntries.some((e) => e.lowConfidence);
  const warnings = Array.from(new Set(parsedEntries.flatMap((e) => e.warnings || [])));

  return finalize({
    intent: 'ledger_entries',
    entries: parsedEntries,
    confidence: overallConfidence,
    lowConfidence,
    warnings,
    reply: buildEntriesReply(parsedEntries),
    raw: trimmed,
  });
}
