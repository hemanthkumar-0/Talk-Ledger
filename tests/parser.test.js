import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildBalanceReply,
  buildDailySummaryReply,
  parseSpokenAmount,
  parseUtterance,
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
