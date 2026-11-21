import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDaysIso,
  computeCustomerDues,
  computePeriodStatement,
  computeProfitLossSeries,
} from '../public/pnl.js';

const REF_DAY = '2026-11-21';

describe('TalkLedger P&L, Dues & Collections Engine (public/pnl.js)', () => {
  it('1. Day 1: Sale 3000, COGS 2250, expense 200 -> profit +550 (green)', () => {
    const records = [
      { kind: 'sale', dateIso: '2026-11-20', revenue: 3000, cogs: 2250 },
      { kind: 'expense', dateIso: '2026-11-20', amount: 200 },
    ];
    const pnl = computeProfitLossSeries(records, { startIso: '2026-11-20', endIso: '2026-11-21' });
    assert.equal(pnl.series[0].profit, 550);
    assert.equal(pnl.series[0].profit > 0, true);
    assert.equal(pnl.netProfit, 550);
  });

  it('2. Day 2: Expense 500 and no sales -> -500 (red)', () => {
    const records = [
      { kind: 'sale', dateIso: '2026-11-20', revenue: 3000, cogs: 2250 },
      { kind: 'expense', dateIso: '2026-11-20', amount: 200 },
      { kind: 'expense', dateIso: '2026-11-21', amount: 500 },
    ];
    const pnl = computeProfitLossSeries(records, { startIso: '2026-11-20', endIso: '2026-11-21' });
    assert.equal(pnl.series[0].profit, 550);
    assert.equal(pnl.series[1].profit, -500);
    assert.equal(pnl.series[1].profit < 0, true);
    assert.equal(pnl.series[1].cumulativeProfit, 50);
    assert.equal(pnl.netProfit, 50);
  });

  it('3. Debit 600 to Ramesh, then Credit 300 -> due amount 300, creditInPeriod 300', () => {
    const entries = [
      { customerName: 'Ramesh', accountingType: 'debit', amount: 600, dateIso: '2026-11-20' },
      { customerName: 'Ramesh', accountingType: 'credit', amount: 300, dateIso: '2026-11-21' },
    ];
    const dues = computeCustomerDues(entries, { referenceDate: REF_DAY, defaultCreditDays: 30 });
    const stmt = computePeriodStatement(entries, { startIso: '2026-11-01', endIso: '2026-11-21' });

    const ramesh = dues.customers.find((c) => c.customerName === 'Ramesh');
    assert.equal(ramesh.totalDebit, 600);
    assert.equal(ramesh.totalCredit, 300);
    assert.equal(ramesh.dueAmount, 300);
    assert.equal(stmt.creditInPeriod, 300);
  });

  it('4. Opening 1000, Debit 600, Credit 300 in the period -> Closing 1300', () => {
    const entries = [
      { customerName: 'Ramesh', accountingType: 'debit', amount: 1000, dateIso: '2026-10-15' },
      { customerName: 'Ramesh', accountingType: 'debit', amount: 600, dateIso: '2026-11-05' },
      { customerName: 'Ramesh', accountingType: 'credit', amount: 300, dateIso: '2026-11-10' },
    ];
    const stmt = computePeriodStatement(entries, { startIso: '2026-11-01', endIso: '2026-11-21' });
    assert.equal(stmt.openingBalance, 1000);
    assert.equal(stmt.debitInPeriod, 600);
    assert.equal(stmt.creditInPeriod, 300);
    assert.equal(stmt.closingBalance, 1300);
    assert.equal(stmt.collectionRate, 300 / 1600);
  });

  it('5. Debit 500 with a due date 10 days ago and no payments -> Overdue 500, 10 days', () => {
    const due10DaysAgo = addDaysIso(REF_DAY, -10);
    const entries = [
      {
        customerName: 'Suresh',
        accountingType: 'debit',
        amount: 500,
        dateIso: addDaysIso(REF_DAY, -40),
        dueDate: due10DaysAgo,
      },
    ];
    const dues = computeCustomerDues(entries, { referenceDate: REF_DAY, defaultCreditDays: 30 });
    const suresh = dues.customers.find((c) => c.customerName === 'Suresh');
    assert.equal(suresh.overdueAmount, 500);
    assert.equal(suresh.daysOverdue, 10);
    assert.equal(dues.totalOverdue, 500);
    assert.equal(dues.ageingBuckets.days8to30, 500);
  });

  it('6. Credit larger than Debit -> shown as Advance, not a negative due', () => {
    const entries = [
      { customerName: 'Meena', accountingType: 'debit', amount: 200, dateIso: '2026-11-18' },
      { customerName: 'Meena', accountingType: 'credit', amount: 500, dateIso: '2026-11-20' },
    ];
    const dues = computeCustomerDues(entries, { referenceDate: REF_DAY });
    const meena = dues.customers.find((c) => c.customerName === 'Meena');
    assert.equal(meena.isAdvance, true);
    assert.equal(meena.advanceAmount, 300);
    assert.equal(meena.positiveDue, 0);
    assert.equal(dues.totalDue, 0);
    assert.equal(dues.advanceCustomers.length, 1);
    assert.equal(dues.dueCustomers.length, 0);
  });

  it('7. Period change updates Opening, Closing, Debit and Credit but NOT all-time Total due', () => {
    const entries = [
      { customerName: 'Kavita', accountingType: 'debit', amount: 1000, dateIso: '2026-10-10' },
      { customerName: 'Kavita', accountingType: 'debit', amount: 400, dateIso: '2026-11-05' },
      { customerName: 'Kavita', accountingType: 'credit', amount: 200, dateIso: '2026-11-18' },
    ];
    const allTimeDues = computeCustomerDues(entries, { referenceDate: REF_DAY });
    const octStmt = computePeriodStatement(entries, { startIso: '2026-10-01', endIso: '2026-10-31' });
    const novStmt = computePeriodStatement(entries, { startIso: '2026-11-01', endIso: '2026-11-21' });

    assert.equal(allTimeDues.totalDue, 1200);
    assert.equal(octStmt.openingBalance, 0);
    assert.equal(octStmt.debitInPeriod, 1000);
    assert.equal(octStmt.closingBalance, 1000);

    assert.equal(novStmt.openingBalance, 1000);
    assert.equal(novStmt.debitInPeriod, 400);
    assert.equal(novStmt.creditInPeriod, 200);
    assert.equal(novStmt.closingBalance, 1200);
    // All-time total due unchanged regardless of period selection
    assert.equal(allTimeDues.totalDue, 1200);
  });

  it('8. Empty data, customer with zero balance, and decimal amounts', () => {
    const emptyDues = computeCustomerDues([], { referenceDate: REF_DAY });
    const emptyStmt = computePeriodStatement([], { startIso: '2026-11-01', endIso: '2026-11-21' });
    const emptyPnl = computeProfitLossSeries([], { startIso: '2026-11-01', endIso: '2026-11-21' });

    assert.equal(emptyDues.totalDue, 0);
    assert.equal(emptyStmt.collectionRate, null);
    assert.equal(emptyPnl.hasAnyData, false);

    const decimalEntries = [
      { customerName: 'ZeroCustomer', accountingType: 'debit', amount: 150.5, dateIso: '2026-11-10' },
      { customerName: 'ZeroCustomer', accountingType: 'credit', amount: 150.5, dateIso: '2026-11-12' },
      { customerName: 'DecimalCustomer', accountingType: 'debit', amount: 99.75, dateIso: '2026-11-15' },
      { customerName: 'DecimalCustomer', accountingType: 'credit', amount: 24.25, dateIso: '2026-11-16' },
    ];
    const dues = computeCustomerDues(decimalEntries, { referenceDate: REF_DAY });
    const zeroCust = dues.customers.find((c) => c.customerName === 'ZeroCustomer');
    const decCust = dues.customers.find((c) => c.customerName === 'DecimalCustomer');

    assert.equal(zeroCust.dueAmount, 0);
    assert.equal(zeroCust.positiveDue, 0);
    assert.equal(zeroCust.advanceAmount, 0);
    assert.equal(decCust.dueAmount, 75.5);
    assert.equal(dues.totalDue, 75.5);
  });
});
