import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTION_SYNONYMS,
  buildBalanceReply,
  buildDailySummaryReply,
  normalizeSpokenNumbers,
  normalizeVoiceTranscript,
  parseSpokenAmount,
  parseUtterance,
  pickBestTranscriptAlternative,
  resolveCustomerName,
  selectEntryToCorrect,
  toLocalIsoDate,
} from '../public/src/parser.js';

const REF_DATE = new Date('2026-11-21T10:30:00');
const TODAY_ISO = toLocalIsoDate(REF_DATE);
const YESTERDAY_DATE = new Date(REF_DATE.getTime());
YESTERDAY_DATE.setDate(YESTERDAY_DATE.getDate() - 1);
const YESTERDAY_ISO = toLocalIsoDate(YESTERDAY_DATE);
const PARSO_DATE = new Date(REF_DATE.getTime());
PARSO_DATE.setDate(PARSO_DATE.getDate() - 2);
const PARSO_ISO = toLocalIsoDate(PARSO_DATE);

describe('TalkLedger Fixed-Rule Parser — Spoken Numbers', () => {
  it('parses Indian spoken shorthand and English number words accurately', () => {
    assert.equal(parseSpokenAmount('three-forty'), 340);
    assert.equal(parseSpokenAmount('three forty'), 340);
    assert.equal(parseSpokenAmount('five hundred and sixty'), 560);
    assert.equal(parseSpokenAmount('five hundred sixty'), 560);
    assert.equal(parseSpokenAmount('twelve fifty'), 1250);
    assert.equal(parseSpokenAmount('twelve-fifty'), 1250);
    assert.equal(parseSpokenAmount('two thousand five hundred'), 2500);
    assert.equal(parseSpokenAmount('one eighty'), 180);
    assert.equal(parseSpokenAmount('six fifty'), 650);
    assert.equal(parseSpokenAmount('twenty five'), 25);
    assert.equal(parseSpokenAmount('twenty five hundred'), 2500);
    assert.equal(parseSpokenAmount('₹1,250'), 1250);
    assert.equal(parseSpokenAmount('Rs. 560/-'), 560);
  });

  it('parses Hindi & Hinglish number words and idioms accurately', () => {
    assert.equal(parseSpokenAmount('ek sau'), 100);
    assert.equal(parseSpokenAmount('do sau'), 200);
    assert.equal(parseSpokenAmount('panch sau'), 500);
    assert.equal(parseSpokenAmount('panch sau saath'), 560);
    assert.equal(parseSpokenAmount('do sau pachas'), 250);
    assert.equal(parseSpokenAmount('hazaar'), 1000);
    assert.equal(parseSpokenAmount('ek hazaar'), 1000);
    assert.equal(parseSpokenAmount('do hazaar panch sau'), 2500);
    assert.equal(parseSpokenAmount('dedh sau'), 150);
    assert.equal(parseSpokenAmount('dhai sau'), 250);
    assert.equal(parseSpokenAmount('saade teen sau'), 350);
  });
});

describe('TalkLedger Fixed-Rule Parser — Multi-Clause Credit & Payment with Dates', () => {
  it('splits compound utterance and carries forward customer pronoun with real dates', () => {
    const res = parseUtterance('Kavita, 560 on credit. She paid 250 yesterday.', {
      referenceDate: REF_DATE,
      customers: ['Kavita', 'Arjun', 'Meena'],
    });

    assert.equal(res.intent, 'ledger_entries');
    assert.equal(res.entries.length, 2);

    assert.equal(res.entries[0].customerName, 'Kavita');
    assert.equal(res.entries[0].amount, 560);
    assert.equal(res.entries[0].signedAmount, 560);
    assert.equal(res.entries[0].type, 'credit');
    assert.equal(res.entries[0].dateIso, TODAY_ISO);
    assert.equal(res.entries[0].dateLabel, 'today');

    assert.equal(res.entries[1].customerName, 'Kavita');
    assert.equal(res.entries[1].amount, 250);
    assert.equal(res.entries[1].signedAmount, -250);
    assert.equal(res.entries[1].type, 'paid');
    assert.equal(res.entries[1].dateIso, YESTERDAY_ISO);
    assert.equal(res.entries[1].dateLabel, 'yesterday');

    assert.equal(res.reply, 'Kavita: 560 credit today, 250 paid yesterday. Saved.');
  });

  it('handles Hinglish multi-clause utterances with udhaar, jama, aaj, kal, and parso', () => {
    const res = parseUtterance('Ramesh ne panch sau saath udhaar liya aaj. Unhone parso do sau pachas jama kiya.', {
      referenceDate: REF_DATE,
    });

    assert.equal(res.intent, 'ledger_entries');
    assert.equal(res.entries.length, 2);
    assert.equal(res.entries[0].customerName, 'Ramesh');
    assert.equal(res.entries[0].amount, 560);
    assert.equal(res.entries[0].type, 'credit');
    assert.equal(res.entries[0].dateIso, TODAY_ISO);

    assert.equal(res.entries[1].customerName, 'Ramesh');
    assert.equal(res.entries[1].amount, 250);
    assert.equal(res.entries[1].type, 'paid');
    assert.equal(res.entries[1].dateIso, PARSO_ISO);
    assert.equal(res.entries[1].dateLabel, 'day before yesterday');
  });

  it('parses spoken word amounts inside ledger sentences without breaking "five hundred and sixty"', () => {
    const r1 = parseUtterance('Arjun took three-forty on credit', { referenceDate: REF_DATE });
    assert.equal(r1.intent, 'ledger_entries');
    assert.equal(r1.entries[0].customerName, 'Arjun');
    assert.equal(r1.entries[0].amount, 340);
    assert.equal(r1.entries[0].type, 'credit');

    const r2 = parseUtterance('Meena paid twelve fifty yesterday', { referenceDate: REF_DATE });
    assert.equal(r2.intent, 'ledger_entries');
    assert.equal(r2.entries[0].customerName, 'Meena');
    assert.equal(r2.entries[0].amount, 1250);
    assert.equal(r2.entries[0].type, 'paid');
    assert.equal(r2.entries[0].dateIso, YESTERDAY_ISO);

    const r3 = parseUtterance('Kavita five hundred and sixty on credit', { referenceDate: REF_DATE });
    assert.equal(r3.intent, 'ledger_entries');
    assert.equal(r3.entries.length, 1);
    assert.equal(r3.entries[0].amount, 560);

    const r4 = parseUtterance(
      'Kavita five hundred and sixty on credit and she paid two hundred and fifty yesterday',
      { referenceDate: REF_DATE }
    );
    assert.equal(r4.intent, 'ledger_entries');
    assert.equal(r4.entries.length, 2);
    assert.equal(r4.entries[0].amount, 560);
    assert.equal(r4.entries[0].type, 'credit');
    assert.equal(r4.entries[1].amount, 250);
    assert.equal(r4.entries[1].type, 'paid');
    assert.equal(r4.entries[1].dateIso, YESTERDAY_ISO);
  });
});

describe('TalkLedger Fixed-Rule Parser — Spoken Corrections (No Duplication)', () => {
  it('detects English & Hinglish corrections and amends the right entry in place', () => {
    for (const phrase of ['No, 650.', 'Sorry, 650', 'Make it 650', 'Nahi, 650', 'No, six fifty.']) {
      const parsed = parseUtterance(phrase, { referenceDate: REF_DATE });
      assert.equal(parsed.intent, 'correction', `Expected correction for "${phrase}"`);
      assert.equal(parsed.amount, 650, `Expected 650 for "${phrase}"`);
    }

    // Verify in-place correction target after the 2-entry Kavita batch:
    const entries = [
      { id: 'e1', customerName: 'Kavita', amount: 560, type: 'credit', dateOffset: 0 },
      { id: 'e2', customerName: 'Kavita', amount: 250, type: 'paid', dateOffset: -1 },
    ];
    const correction = parseUtterance('No, 650.', { referenceDate: REF_DATE });
    const target = selectEntryToCorrect(entries, correction, ['e1', 'e2']);
    assert.equal(target.id, 'e1');
    assert.equal(target.type, 'credit');
    assert.equal(entries.length, 2); // never duplicates
  });
});

describe('TalkLedger Fixed-Rule Parser — Same-Name Disambiguation', () => {
  it('pauses saving when multiple customers share the spoken name and resolves cleanly', () => {
    const customers = ['Kavita Sharma', 'Kavita Verma', 'Arjun'];
    const first = parseUtterance('Kavita, 340 on credit', {
      referenceDate: REF_DATE,
      customers,
    });

    assert.equal(first.intent, 'disambiguation_required');
    assert.equal(first.forIntent, 'ledger_entries');
    assert.deepEqual(first.candidates, ['Kavita Sharma', 'Kavita Verma']);
    assert.equal(first.reply, 'Which Kavita? Kavita Sharma or Kavita Verma?');

    const resolved = parseUtterance('Kavita Sharma', {
      referenceDate: REF_DATE,
      customers,
      pendingDisambiguation: first,
    });

    assert.equal(resolved.intent, 'disambiguation_resolved');
    assert.equal(resolved.selectedCustomer, 'Kavita Sharma');
  });

  it('also disambiguates spoken surname-only answer ("Verma")', () => {
    const customers = ['Kavita Sharma', 'Kavita Verma'];
    const pending = parseUtterance('What is Kavita total?', {
      referenceDate: REF_DATE,
      customers,
    });

    assert.equal(pending.intent, 'disambiguation_required');
    assert.equal(pending.forIntent, 'balance_query');

    const resolved = parseUtterance('Verma', {
      referenceDate: REF_DATE,
      customers,
      pendingDisambiguation: pending,
    });

    assert.equal(resolved.intent, 'disambiguation_resolved');
    assert.equal(resolved.selectedCustomer, 'Kavita Verma');
  });
});

describe('TalkLedger Fixed-Rule Parser — Instant Balance & Daily Queries', () => {
  it('parses customer balance queries and formats exact spoken replies', () => {
    const q1 = parseUtterance("What is Kavita's total?", { customers: ['Kavita', 'Arjun'] });
    assert.equal(q1.intent, 'balance_query');
    assert.equal(q1.customerName, 'Kavita');

    const q2 = parseUtterance('How much does Kavita owe?', { customers: ['Kavita', 'Arjun'] });
    assert.equal(q2.intent, 'balance_query');
    assert.equal(q2.customerName, 'Kavita');

    const q3 = parseUtterance('Kavita ka total kitna hai?', { customers: ['Kavita', 'Arjun'] });
    assert.equal(q3.intent, 'balance_query');
    assert.equal(q3.customerName, 'Kavita');

    assert.equal(buildBalanceReply('Kavita', 400), 'Kavita owes 400.');
    assert.equal(buildBalanceReply('Kavita', 0), "Kavita's account is settled.");
  });

  it('parses daily summary queries ("Today\'s total", "Aaj ka total")', () => {
    const d1 = parseUtterance("Today's total", { referenceDate: REF_DATE });
    assert.equal(d1.intent, 'daily_summary_query');
    assert.equal(d1.dateIso, TODAY_ISO);

    const d2 = parseUtterance('Aaj ka total', { referenceDate: REF_DATE });
    assert.equal(d2.intent, 'daily_summary_query');

    assert.equal(
      buildDailySummaryReply(740, 650),
      "Today's total: 740 credit given and 650 received."
    );
  });
});

describe('Voice Khata Enhanced Speech Accuracy & N-Best Scoring', () => {
  it('repairs Indian-English STT homophones, filler prefixes, split digits, and local script digits', () => {
    const p1 = parseUtterance('Please add Ramesh 500 created', { referenceDate: REF_DATE });
    assert.equal(p1.intent, 'ledger_entries');
    assert.equal(p1.entries[0].customerName, 'Ramesh');
    assert.equal(p1.entries[0].amount, 500);
    assert.equal(p1.entries[0].type, 'credit');

    const p2 = parseUtterance('Kavita payed Rs. 250/- yesterday', { referenceDate: REF_DATE });
    assert.equal(p2.intent, 'ledger_entries');
    assert.equal(p2.entries[0].customerName, 'Kavita');
    assert.equal(p2.entries[0].amount, 250);
    assert.equal(p2.entries[0].type, 'paid');
    assert.equal(p2.entries[0].dateIso, YESTERDAY_ISO);

    // Devanagari & Kannada digits
    assert.equal(normalizeVoiceTranscript('Ramesh ५६० credit'), 'Ramesh 560 credit');
    const p3 = parseUtterance('Suresh ೩೪೦ udhaar', { referenceDate: REF_DATE });
    assert.equal(p3.intent, 'ledger_entries');
    assert.equal(p3.entries[0].customerName, 'Suresh');
    assert.equal(p3.entries[0].amount, 340);
    assert.equal(p3.entries[0].type, 'credit');
  });

  it('snaps minor STT customer name mishearings fuzzily to existing customers without false collisions', () => {
    const customers = [{ name: 'Ramesh' }, { name: 'Sunita' }, { name: 'Raja' }];
    const p1 = parseUtterance('Ramish 400 paid', { referenceDate: REF_DATE, customers });
    assert.equal(p1.intent, 'ledger_entries');
    assert.equal(p1.entries[0].customerName, 'Ramesh');

    // Short 4-char distinct name ("Raju" vs "Raja") must NOT falsely collide
    const p2 = parseUtterance('Raju 150 credit', { referenceDate: REF_DATE, customers });
    assert.equal(p2.intent, 'ledger_entries');
    assert.equal(p2.entries[0].customerName, 'Raju');
  });

  it('picks the best parseable hypothesis across Web Speech N-best alternatives', () => {
    const customers = [{ name: 'Ramesh' }];
    const best = pickBestTranscriptAlternative(
      [
        { transcript: 'raw mesh five', confidence: 0.68 },
        { transcript: 'Ramesh 500 credit', confidence: 0.64 },
      ],
      { referenceDate: REF_DATE, customers }
    );
    assert.equal(best.transcript, 'Ramesh 500 credit');
    assert.equal(best.parsed.intent, 'ledger_entries');
    assert.equal(best.parsed.entries[0].customerName, 'Ramesh');
    assert.equal(best.parsed.entries[0].amount, 500);
  });
});

describe('Voice Khata Comprehensive Multilingual Suite (36 Sample Sentences — EN / HI / KN / Hinglish)', () => {
  const KNOWN_CUSTOMERS = [
    { name: 'Ramesh' },
    { name: 'Sunita' },
    { name: 'Prashant' },
    { name: 'Deepak' },
    { name: 'Kavita' },
    { name: 'Suresh' },
    { name: 'Meena' },
    { name: 'Lakshmi' },
    { name: 'Manjunath' },
    { name: 'Ganesh' },
  ];

  const CASES = [
    // --- English (10) ---
    { label: 'EN-01 five hundred credit', text: 'Ramesh five hundred credit', name: 'Ramesh', action: 'CREDIT', amount: 500 },
    { label: 'EN-02 given -> CREDIT', text: 'Sunita 750 given', name: 'Sunita', action: 'CREDIT', amount: 750 },
    { label: 'EN-03 received -> PAYMENT', text: 'Received two thousand from Deepak', name: 'Deepak', action: 'PAYMENT', amount: 2000 },
    { label: 'EN-04 paid shorthand twelve fifty', text: 'Meena paid twelve fifty yesterday', name: 'Meena', action: 'PAYMENT', amount: 1250 },
    { label: 'EN-05 currency formatted INR', text: 'Suresh took ₹1,450 on credit', name: 'Suresh', action: 'CREDIT', amount: 1450 },
    { label: 'EN-06 a hundred and twenty', text: 'Kavita a hundred and twenty credit', name: 'Kavita', action: 'CREDIT', amount: 120 },
    { label: 'EN-07 Rs slash-dash payment', text: 'Lakshmi returned Rs. 600/-', name: 'Lakshmi', action: 'PAYMENT', amount: 600 },
    { label: 'EN-08 three forty credit', text: 'Ganesh three forty credit', name: 'Ganesh', action: 'CREDIT', amount: 340 },
    { label: 'EN-09 UPI settled payment', text: 'Prashant 890 upi', name: 'Prashant', action: 'PAYMENT', amount: 890 },
    { label: 'EN-10 owes two thousand five hundred', text: 'Manjunath owes two thousand five hundred', name: 'Manjunath', action: 'CREDIT', amount: 2500 },

    // --- Hinglish / Romanized Hindi (10) ---
    { label: 'HING-11 paanch sau udhaar', text: 'Ramesh paanch sau udhaar', name: 'Ramesh', action: 'CREDIT', amount: 500 },
    { label: 'HING-12 do hazaar udhar', text: 'Suresh do hazaar udhar', name: 'Suresh', action: 'CREDIT', amount: 2000 },
    { label: 'HING-13 dedh sau credit', text: 'Meena ne dedh sau udhaar liya', name: 'Meena', action: 'CREDIT', amount: 150 },
    { label: 'HING-14 dhai sau jama', text: 'Kavita dhai sau jama', name: 'Kavita', action: 'PAYMENT', amount: 250 },
    { label: 'HING-15 wapas payment', text: 'Deepak ne char sau wapas kiya', name: 'Deepak', action: 'PAYMENT', amount: 400 },
    { label: 'HING-16 saade teen sau baaki', text: 'Sunita saade teen sau baaki', name: 'Sunita', action: 'CREDIT', amount: 350 },
    { label: 'HING-17 sava hazaar jama', text: 'Prashant sava hazaar jama', name: 'Prashant', action: 'PAYMENT', amount: 1250 },
    { label: 'HING-18 paune do sau udhaar', text: 'Ganesh paune do sau udhaar', name: 'Ganesh', action: 'CREDIT', amount: 175 },
    { label: 'HING-19 ek hazaar do sau pachas', text: 'Ramesh ek hazaar do sau pachas paid', name: 'Ramesh', action: 'PAYMENT', amount: 1250 },
    { label: 'HING-20 teen sau assi khata', text: 'Lakshmi teen sau assi khata likho', name: 'Lakshmi', action: 'CREDIT', amount: 380 },

    // --- Devanagari Hindi (5) ---
    { label: 'HI-21 Devanagari paanch sau udhaar', text: 'रमेश ने पांच सौ उधार लिया', name: 'रमेश', action: 'CREDIT', amount: 500 },
    { label: 'HI-22 Devanagari do hazaar jama', text: 'सुनीता दो हजार जमा', name: 'सुनीता', action: 'PAYMENT', amount: 2000 },
    { label: 'HI-23 Devanagari dedh sau baaki', text: 'दीपक डेढ़ सौ बाकी', name: 'दीपक', action: 'CREDIT', amount: 150 },
    { label: 'HI-24 Devanagari dhai sau wapas', text: 'कविता ढाई सौ वापस दिया', name: 'कविता', action: 'PAYMENT', amount: 250 },
    { label: 'HI-25 Devanagari digits with udhaar', text: 'Ramesh ७५० उधार', name: 'Ramesh', action: 'CREDIT', amount: 750 },

    // --- Kannada Romanized & Native Script (7) ---
    { label: 'KN-26 ainooru saala', text: 'Ramesh ainooru saala', name: 'Ramesh', action: 'CREDIT', amount: 500 },
    { label: 'KN-27 eradu saavira kottaru', text: 'Manjunath eradu saavira kottaru', name: 'Manjunath', action: 'PAYMENT', amount: 2000 },
    { label: 'KN-28 noora aivattu baaki', text: 'Lakshmi noora aivattu baaki', name: 'Lakshmi', action: 'CREDIT', amount: 150 },
    { label: 'KN-29 innoora aivattu jama', text: 'Ganesh innoora aivattu jama', name: 'Ganesh', action: 'PAYMENT', amount: 250 },
    { label: 'KN-30 munnoora nalavattu saala', text: 'Suresh munnoora nalavattu saala', name: 'Suresh', action: 'CREDIT', amount: 340 },
    { label: 'KN-31 Kannada script ainooru saala', text: 'ರಮೇಶ್ ಐನೂರು ಸಾಲ', name: 'ರಮೇಶ್', action: 'CREDIT', amount: 500 },
    { label: 'KN-32 Kannada script eradu saavira kottaru', text: 'ಲಕ್ಷ್ಮಿ ಎರಡು ಸಾವಿರ ಕೊಟ್ಟರು', name: 'ಲಕ್ಷ್ಮಿ', action: 'PAYMENT', amount: 2000 },

    // --- Name Variants & Fuzzy Matching (4) ---
    { label: 'NAME-33 phonetic Suneeta -> Sunita', text: 'Suneeta 450 paid', name: 'Sunita', action: 'PAYMENT', amount: 450 },
    { label: 'NAME-34 typo Ramish -> Ramesh (uncertain)', text: 'Ramish 300 udhaar', name: 'Ramesh', action: 'CREDIT', amount: 300, expectUncertain: true },
    { label: 'NAME-35 phonetic Prashanth -> Prashant', text: 'Prashanth 900 received', name: 'Prashant', action: 'PAYMENT', amount: 900 },
    { label: 'NAME-36 typo Manjunat -> Manjunath (uncertain)', text: 'Manjunat 1100 credit', name: 'Manjunath', action: 'CREDIT', amount: 1100, expectUncertain: true },
  ];

  it('parses all 36 multilingual sentences with exact customer, normalized action, amount & confidence', () => {
    assert.ok(CASES.length >= 30, 'Suite must cover at least 30 sample sentences');

    for (const tc of CASES) {
      const res = parseUtterance(tc.text, {
        referenceDate: REF_DATE,
        customers: KNOWN_CUSTOMERS,
      });

      assert.equal(res.intent, 'ledger_entries', `[${tc.label}] expected ledger_entries for "${tc.text}"`);
      assert.equal(res.entries.length, 1, `[${tc.label}] expected 1 entry`);
      const entry = res.entries[0];
      assert.equal(entry.customerName, tc.name, `[${tc.label}] customer mismatch`);
      assert.equal(entry.action, tc.action, `[${tc.label}] action mismatch`);
      assert.equal(entry.type, tc.action === 'PAYMENT' ? 'paid' : 'credit', `[${tc.label}] type mismatch`);
      assert.equal(entry.amount, tc.amount, `[${tc.label}] amount mismatch`);
      assert.ok(
        typeof entry.confidence === 'number' && entry.confidence > 0 && entry.confidence <= 1,
        `[${tc.label}] expected valid numeric confidence score`
      );

      if (tc.expectUncertain) {
        assert.equal(entry.uncertainMatch, true, `[${tc.label}] expected uncertainMatch flag`);
        assert.equal(entry.lowConfidence, true, `[${tc.label}] expected lowConfidence warning`);
      }
    }
  });

  it('exposes action synonym map, spoken number normalizer, and low-confidence flags accurately', () => {
    // Action synonym normalization
    assert.equal(ACTION_SYNONYMS.udhaar, 'CREDIT');
    assert.equal(ACTION_SYNONYMS.udhar, 'CREDIT');
    assert.equal(ACTION_SYNONYMS.credit, 'CREDIT');
    assert.equal(ACTION_SYNONYMS.given, 'CREDIT');
    assert.equal(ACTION_SYNONYMS.jama, 'PAYMENT');
    assert.equal(ACTION_SYNONYMS.received, 'PAYMENT');
    assert.equal(ACTION_SYNONYMS.paid, 'PAYMENT');
    assert.equal(ACTION_SYNONYMS.wapas, 'PAYMENT');

    // Spoken number normalization helper
    assert.equal(normalizeSpokenNumbers('Ramesh paanch sau udhaar'), 'Ramesh 500 udhaar');
    assert.equal(normalizeSpokenNumbers('Suresh do hazaar jama'), 'Suresh 2000 jama');
    assert.equal(normalizeSpokenNumbers('Meena dedh sau credit'), 'Meena 150 credit');
    assert.equal(normalizeSpokenNumbers('Lakshmi ainooru saala'), 'Lakshmi 500 saala');

    // Missing action keyword -> defaults to CREDIT with lowConfidence warning
    const implicit = parseUtterance('Ramesh 500', {
      referenceDate: REF_DATE,
      customers: KNOWN_CUSTOMERS,
    });
    assert.equal(implicit.intent, 'ledger_entries');
    assert.equal(implicit.entries[0].action, 'CREDIT');
    assert.equal(implicit.entries[0].directionExplicit, false);
    assert.equal(implicit.lowConfidence, true);
    assert.ok(implicit.warnings.length >= 1);

    // Low STT confidence triggers lowConfidence warning even when syntax is clean
    const lowStt = parseUtterance('Ramesh 500 credit', {
      referenceDate: REF_DATE,
      customers: KNOWN_CUSTOMERS,
      sttConfidence: 0.55,
    });
    assert.equal(lowStt.lowConfidence, true);
    assert.ok(lowStt.confidence < 0.78);

    // Fuzzy resolver reports uncertainMatch metadata clearly
    const fuzzy = resolveCustomerName('Ramish', KNOWN_CUSTOMERS);
    assert.equal(fuzzy.name, 'Ramesh');
    assert.equal(fuzzy.fuzzy, true);
    assert.equal(fuzzy.uncertainMatch, true);
  });
});
