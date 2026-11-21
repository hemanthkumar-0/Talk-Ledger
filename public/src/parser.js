/**
 * TalkLedger Deterministic Fixed-Rule Ledger Parser
 * ZERO LLM between voice and the books.
 * Pure, synchronous, zero-latency rule engine supporting English + Hinglish.
 */

const UNITS = {
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
};

const TEENS = {
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
};

const TENS = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
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
};

const COMPOUND_NUMBERS = {
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
};

const SCALES = {
  hundred: 100,
  sau: 100,
  sow: 100,
  thousand: 1000,
  hazaar: 1000,
  hazar: 1000,
  lakh: 100000,
  lac: 100000,
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

const CREDIT_KEYWORDS = new Set([
  'credit',
  'udhaar',
  'udhar',
  'baaki',
  'baki',
  'took',
  'take',
  'owes',
  'owe',
  'liya',
  'liye',
  'li',
  'khata',
  'khaata',
  'debit',
  'lent',
  'borrowed',
  'due',
  'pending',
  'bill',
  'tab',
  'charge',
  'likh',
  'likho',
]);

const PAYMENT_KEYWORDS = new Set([
  'paid',
  'pay',
  'gave',
  'give',
  'returned',
  'return',
  'received',
  'receive',
  'jama',
  'diya',
  'diye',
  'di',
  'settled',
  'settle',
  'deposited',
  'deposit',
  'cleared',
  'clear',
  'vasool',
  'mila',
  'mile',
  'wapas',
  'vapas',
  'cash',
  'upi',
]);

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
  'only',
  'today',
  'yesterday',
  'day',
  'before',
  'aaj',
  'kal',
  'parso',
  'parson',
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
  'please',
  'ji',
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
 * Resolves relative date words (today/aaj, yesterday/kal, day before yesterday/parso)
 * into real ISO dates relative to referenceDate.
 */
export function parseRelativeDate(text, referenceDate = new Date()) {
  const lower = text.toLowerCase();
  const base = new Date(referenceDate.getTime());
  base.setHours(12, 0, 0, 0);

  if (/\b(day\s+before\s+yesterday|parso|parson)\b/.test(lower)) {
    base.setDate(base.getDate() - 2);
    return {
      dateIso: toLocalIsoDate(base),
      dateLabel: 'day before yesterday',
      dateOffset: -2,
    };
  }

  if (/\b(yesterday|kal)\b/.test(lower)) {
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
 * Handles standard English, Indian spoken shorthand ("three-forty" -> 340, "twelve fifty" -> 1250),
 * and Hindi/Hinglish numbers ("panch sau saath" -> 560, "ek hazaar" -> 1000).
 */
export function evaluateNumberTokens(tokens) {
  if (!tokens || tokens.length === 0) return null;

  // Handle pure numeric digit string first (including e.g. ["560"] or ["1250"])
  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
    return parseInt(tokens[0], 10);
  }

  let total = 0;
  let current = 0;
  let lastKind = null; // 'unit' | 'teen' | 'ten' | 'compound' | 'hundred' | 'scale' | 'shorthand_ten'

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === 'and' || tok === 'aur') continue;

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
        // e.g. "two five" spoken digits or edge case
        current = current * 10 + val;
        lastKind = 'compound';
      }
      continue;
    }

    if (tok in TEENS) {
      const val = TEENS[tok];
      if ((lastKind === 'unit' || lastKind === 'teen') && current > 0 && current < 20) {
        // e.g. "three fifteen" -> 315
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
        // Spoken shorthand: "three forty" -> 340, "twelve fifty" -> 1250, "twenty fifty" -> 2050
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
      if ((lastKind === 'unit' || lastKind === 'teen') && current > 0 && current < 20) {
        current = current * 100 + val;
      } else {
        current += val;
      }
      lastKind = 'compound';
    }
  }

  const result = total + current;
  return Number.isFinite(result) && result >= 0 ? result : null;
}

/**
 * Normalizes idiomatic Hindi half/quarter phrases (dedh sau, dhai sau, saade teen sau, etc.)
 * into exact digit strings before general word-number scanning.
 */
function expandHindiIdioms(input) {
  let out = input;

  // dedh / dhai with sau / hazaar
  out = out.replace(/\bdedh\s+(sau|sow)\b/gi, '150');
  out = out.replace(/\bdhai\s+(sau|sow)\b/gi, '250');
  out = out.replace(/\bdedh\s+(hazaar|hazar)\b/gi, '1500');
  out = out.replace(/\bdhai\s+(hazaar|hazar)\b/gi, '2500');
  out = out.replace(/\bsava\s+(sau|sow)\b/gi, '125');
  out = out.replace(/\bsava\s+(hazaar|hazar)\b/gi, '1250');

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
 * Parses an exact integer amount from any spoken phrase.
 * Also returns the matched token span so name extraction can cleanly strip it.
 */
export function parseSpokenAmountWithSpan(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { amount: null, matchedText: '' };
  }

  const expanded = expandHindiIdioms(rawText);

  // 1. Check explicit formatted numeric figures first (₹1,250, Rs. 560, 650/-, 250)
  //    Wait: check if numeric digit is followed by a scale word like "5 hundred" or "2 thousand"
  const normalized = expanded
    .replace(/₹/g, ' ')
    .replace(/\bRs\.?\s*/gi, ' ')
    .replace(/(\d),(?=\d{2,3}\b)/g, '$1')
    .replace(/\/-/g, ' ')
    .replace(/[-–—]/g, ' ');

  // Tokenize keeping track of character indices
  const tokenRegex = /[A-Za-z0-9']+/g;
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
        (curr === 'and' || curr === 'aur') &&
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
      const span = {
        amount: value,
        start: rawTokens[i].start,
        end: rawTokens[j - 1].end,
        matchedText: normalized.slice(rawTokens[i].start, rawTokens[j - 1].end),
        tokenIndices: new Set(Array.from({ length: j - i }, (_, k) => i + k)),
      };
      // Pick first strong amount in this clause
      bestSpan = span;
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

/**
 * Convenience helper returning just the exact integer amount (or null).
 */
export function parseSpokenAmount(text) {
  return parseSpokenAmountWithSpan(text).amount;
}

/**
 * Splits a multi-clause utterance into independent clauses without breaking
 * compound numbers like "five hundred and sixty".
 */
export function splitIntoClauses(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  // Normalize sentence delimiters first
  const primaryParts = rawText
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?:[.!?;\n]+)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  const clauses = [];

  for (const part of primaryParts) {
    // Protect compound spoken numbers like "five hundred and sixty" or "two thousand and five hundred"
    const protectedPart = part.replace(
      /\b(hundred|thousand|lakh|lac|sau|sow|hazaar|hazar)\s+(and|aur)\s+(?=(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|ek|do|teen|char|chaar|panch|paanch|chhe|che|saat|aath|nau|das|bees|tees|chalis|pachas|saath|sattar|assi|nabbe|\d+)\b)/gi,
      '$1 __NUM_AND__ '
    );

    // Check if part contains secondary splitters (" and ", " aur ", " also ", " but ", " lekin ", ", ")
    // ONLY split if BOTH sides independently contain a spoken/numeric amount.
    const splitCandidates = protectedPart
      .split(/\s+(?:and|aur|also|but|lekin)\s+|,\s+(?=(?:she|he|they|unhone|usne|woh|wo|paid|gave|took|credit|received|returned|yesterday|today|kal|aaj|[A-Z]))/i)
      .map((s) => s.replace(/__NUM_AND__/g, 'and'));

    if (splitCandidates.length > 1) {
      // Merge adjacent fragments that don't each hold an amount
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
 * Detects whether a clause represents 'credit' (+) or 'paid' (-).
 */
export function detectDirection(text) {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let creditScore = 0;
  let paidScore = 0;

  for (const tok of tokens) {
    if (CREDIT_KEYWORDS.has(tok)) creditScore += 1;
    if (PAYMENT_KEYWORDS.has(tok)) paidScore += 1;
  }

  if (/\bon\s+credit\b/i.test(text) || /\budhaar\s+liya\b/i.test(text)) {
    creditScore += 2;
  }
  if (/\bpaid\s+back\b/i.test(text) || /\bjama\s+kiya\b/i.test(text)) {
    paidScore += 2;
  }

  if (paidScore > creditScore) return 'paid';
  if (creditScore > paidScore) return 'credit';
  return 'credit';
}

function toTitleCase(name) {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function hasPronounSubject(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.some((w) => PRONOUNS.has(w));
}

/**
 * Extracts customer name from a clause after removing amount, date, action, and filler words.
 */
function extractCustomerName(cleanedWithoutAmount) {
  const cleaned = cleanedWithoutAmount
    .replace(/'s\b/gi, '')
    .replace(/[^A-Za-z\s]/g, ' ')
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
  // Cap at 3 words for a customer name (e.g., "Kavita Sharma")
  return toTitleCase(words.slice(0, 3).join(' '));
}

/**
 * Checks whether a spoken customer name uniquely matches or collides with
 * multiple customers on file (e.g., "Kavita" -> ["Kavita Sharma", "Kavita Verma"]).
 */
export function resolveCustomerName(spokenName, existingCustomers = []) {
  if (!spokenName) {
    return { status: 'missing', name: null, candidates: [] };
  }

  const normalizedNames = existingCustomers
    .map((c) => (typeof c === 'string' ? c : c?.name))
    .filter(Boolean);
  const uniqueNames = Array.from(new Set(normalizedNames));

  const query = spokenName.trim().toLowerCase();

  // 1. Exact case-insensitive match
  const exact = uniqueNames.find((n) => n.toLowerCase() === query);
  if (exact) {
    // Still check if user said a single first name AND there are multiple full names sharing that first name
    // (only happens if both "Kavita" AND "Kavita Sharma" exist — exact match wins unless ambiguous full names exist)
    return { status: 'resolved', name: exact, candidates: [exact] };
  }

  // 2. First-name or token-prefix matches (e.g. "Kavita" matching "Kavita Sharma" and "Kavita Verma")
  const matches = uniqueNames.filter((full) => {
    const parts = full.toLowerCase().split(/\s+/);
    return parts[0] === query || full.toLowerCase().startsWith(`${query} `);
  });

  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      name: toTitleCase(spokenName),
      candidates: matches,
    };
  }

  if (matches.length === 1) {
    return { status: 'resolved', name: matches[0], candidates: matches };
  }

  return { status: 'new', name: toTitleCase(spokenName), candidates: [] };
}

export function buildDisambiguationPrompt(baseName, candidates) {
  if (candidates.length === 2) {
    return `Which ${baseName}? ${candidates[0]} or ${candidates[1]}?`;
  }
  const head = candidates.slice(0, -1).join(', ');
  const tail = candidates[candidates.length - 1];
  return `Which ${baseName}? ${head}, or ${tail}?`;
}

export function buildEntriesReply(entries) {
  if (!entries || entries.length === 0) {
    return 'I did not catch an amount. Please say the customer name and amount.';
  }

  if (entries.length === 1) {
    const e = entries[0];
    return `${e.customerName}, ${e.amount} ${e.type} ${e.dateLabel}. Saved.`;
  }

  const firstCustomer = entries[0].customerName;
  const sameCustomer = entries.every((e) => e.customerName === firstCustomer);

  if (sameCustomer) {
    const summaryParts = entries.map((e) => `${e.amount} ${e.type} ${e.dateLabel}`);
    return `${firstCustomer}: ${summaryParts.join(', ')}. Saved.`;
  }

  const parts = entries.map((e) => `${e.customerName} ${e.amount} ${e.type}`);
  return `Saved ${entries.length} entries: ${parts.join(', ')}.`;
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

/**
 * Deterministically selects which ledger entry a spoken correction ("No, 650.")
 * should amend in place without ever creating a duplicate row.
 */
export function selectEntryToCorrect(entries, correction, lastBatchIds = []) {
  if (!entries || entries.length === 0) return null;

  const batchEntries =
    lastBatchIds && lastBatchIds.length > 0
      ? entries.filter((e) => lastBatchIds.includes(e.id))
      : [];

  const pool = batchEntries.length > 0 ? batchEntries : [entries[entries.length - 1]];

  // 1. If correction explicitly names a customer or type, filter by it
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

  if (filtered.length === 1) {
    return filtered[0];
  }

  // 2. For multi-entry batches (e.g., "+560 credit today" + "-250 paid yesterday"),
  //    if one entry is a classic digit transposition of the corrected amount (560 <-> 650), pick it!
  const anagramMatch = filtered.find((e) => isDigitAnagramOrClose(e.amount, correction.amount));
  if (anagramMatch) {
    return anagramMatch;
  }

  // 3. Otherwise prefer today's entry / primary credit entry in the last batch
  const todayCredit = filtered.find((e) => e.dateOffset === 0 && e.type === 'credit');
  if (todayCredit) {
    return todayCredit;
  }

  return filtered[filtered.length - 1];
}

/**
 * Attempts to resolve an active disambiguation prompt from the user's spoken reply.
 */
function tryResolveDisambiguation(rawText, pending) {
  const lower = rawText.toLowerCase().trim();
  if (/^(cancel|stop|never\s*mind|chhodo|nahi)$/i.test(lower)) {
    return { intent: 'disambiguation_cancel', reply: 'Cancelled. Nothing was saved.' };
  }

  const candidates = pending.candidates || [];
  if (candidates.length === 0) return null;

  // Ordinal matches ("first", "1", "second", "2", "pehla", "doosra")
  if (/\b(first|1st|one|1|pehla|pehle)\b/.test(lower) && candidates[0]) {
    return {
      intent: 'disambiguation_resolved',
      selectedCustomer: candidates[0],
      pending,
    };
  }
  if (/\b(second|2nd|two|2|doosra|dusra)\b/.test(lower) && candidates[1]) {
    return {
      intent: 'disambiguation_resolved',
      selectedCustomer: candidates[1],
      pending,
    };
  }

  // Exact or distinguishing-token match (e.g. "Kavita Sharma" or just "Sharma")
  const tokens = lower.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const scored = candidates
    .map((candidate) => {
      const cLower = candidate.toLowerCase();
      if (lower.includes(cLower)) return { candidate, score: 100 };
      const cParts = cLower.split(/\s+/);
      // Last-name / unique part match
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
    };
  }

  return null;
}

/**
 * Checks whether an utterance is a spoken correction ("No, 650.", "Sorry, 650", "Make it 650", "Nahi, 650").
 */
function parseCorrectionUtterance(rawText) {
  const trimmed = rawText.trim();
  const correctionLead =
    /^(?:no|nope|sorry|wait|actually|nahi|nahin|galat|galti|make\s+it|change\s+(?:it\s+)?to|correct(?:\s+it)?\s+to|i\s+meant|meant)\b/i;

  if (!correctionLead.test(trimmed)) return null;

  const { amount, cleanedText } = parseSpokenAmountWithSpan(trimmed);
  if (amount === null) return null;

  const lower = trimmed.toLowerCase();
  let explicitType = null;
  if (/\b(paid|received|gave|jama|diya|returned)\b/.test(lower)) {
    explicitType = 'paid';
  } else if (/\b(credit|udhaar|udhar|baaki|took|owes)\b/.test(lower)) {
    explicitType = 'credit';
  }

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
    raw: trimmed,
  };
}

/**
 * Checks whether an utterance is a daily summary query ("Today's total", "Aaj ka total").
 */
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
    raw: rawText.trim(),
  };
}

/**
 * Checks whether an utterance is a customer balance query
 * ("What is Kavita's total?", "How much does Kavita owe?", "Kavita ka hisaab").
 */
function parseBalanceQuery(rawText, customers = []) {
  const trimmed = rawText.trim();
  const patterns = [
    /(?:what(?:'s|\s+is)\s+)([A-Za-z][A-Za-z\s]{0,30}?)(?:'s)?\s+(?:total|balance|due|credit|owes|pending|account|hisab|hisaab)\b/i,
    /how\s+much\s+(?:does\s+|is\s+)?([A-Za-z][A-Za-z\s]{0,30}?)\s+(?:owe|owes|baaki|baki|due|pending)\b/i,
    /([A-Za-z][A-Za-z\s]{0,30}?)\s+ka\s+(?:total|hisab|hisaab|baaki|baki|balance|udhaar|udhar)\b/i,
    /(?:check|show|tell(?:\s+me)?|get)\s+([A-Za-z][A-Za-z\s]{0,30}?)(?:'s)?\s+(?:total|balance|account|due)\b/i,
    /^([A-Za-z][A-Za-z\s]{0,24}?)(?:'s)?\s+(?:total|balance|hisab|hisaab)\??$/i,
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
          raw: trimmed,
        };
      }

      return {
        intent: 'balance_query',
        customerName: resolved.name,
        raw: trimmed,
      };
    }
  }

  return null;
}

/**
 * Main deterministic entry point.
 * Parses any English or Hinglish shopkeeper utterance into structured ledger actions.
 */
export function parseUtterance(rawText, context = {}) {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const trimmed = String(rawText || '').trim();
  const referenceDate = context.referenceDate ? new Date(context.referenceDate) : new Date();
  const customers = context.customers || [];

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
  if (/^(hello|hi|hey|namaste|namaskar|good\s+(morning|afternoon|evening))[\s!.,?]*$/i.test(trimmed)) {
    return finalize({
      intent: 'greeting',
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

    const direction = detectDirection(clause);
    const { dateIso, dateLabel, dateOffset } = parseRelativeDate(clause, referenceDate);
    const usesPronoun = hasPronounSubject(clause);
    const extractedName = extractCustomerName(cleanedText);

    let finalCustomer = null;

    if (extractedName) {
      const resolution = resolveCustomerName(extractedName, customers);
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
    } else if (activeCustomer) {
      finalCustomer = activeCustomer;
    }

    if (!finalCustomer) {
      continue;
    }

    parsedEntries.push({
      customerName: finalCustomer,
      amount,
      signedAmount: direction === 'credit' ? amount : -amount,
      type: direction,
      dateIso,
      dateLabel,
      dateOffset,
      sourceClause: clause,
    });
  }

  if (parsedEntries.length === 0) {
    return finalize({
      intent: 'unknown',
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
      reply: buildDisambiguationPrompt(pendingAmbiguity.baseName, pendingAmbiguity.candidates),
      raw: trimmed,
    });
  }

  return finalize({
    intent: 'ledger_entries',
    entries: parsedEntries,
    reply: buildEntriesReply(parsedEntries),
    raw: trimmed,
  });
}
