/**
 * TalkLedger Pure Financial Accounting, Dues, Collections & Profit/Loss Engine
 * Pure ES module — ZERO DOM code, ZERO mutations, NO premature rounding.
 */

const MS_PER_DAY = 86400000;

export function toIsoDay(input) {
  if (!input) return null;
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    return input.trim();
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseUtcDayMs(isoDay) {
  const iso = toIsoDay(isoDay);
  if (!iso) return NaN;
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDaysIso(isoDay, days) {
  const ms = parseUtcDayMs(isoDay);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + days * MS_PER_DAY);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function diffDaysIso(fromIso, toIso) {
  const a = parseUtcDayMs(fromIso);
  const b = parseUtcDayMs(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / MS_PER_DAY);
}

/**
 * Resolves a ledger entry to accounting Debit ('debit' = customer owes more)
 * or Credit ('credit' = payment received from customer).
 */
export function resolveAccountingSide(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const explicit = String(
    entry.accountingType || entry.side || entry.kind || ''
  ).toLowerCase();

  if (explicit === 'debit' || explicit === 'dr' || explicit === 'gave' || explicit === 'credit_sale') {
    return 'debit';
  }
  if (explicit === 'credit' || explicit === 'cr' || explicit === 'payment' || explicit === 'paid' || explicit === 'received') {
    return 'credit';
  }

  // Legacy TalkLedger voice parser entries: type === 'credit' means udhaar given (Debit Dr);
  // type === 'paid' means payment received (Credit Cr).
  const legacyType = String(entry.type || '').toLowerCase();
  if (legacyType === 'debit' || legacyType === 'gave' || legacyType === 'credit') {
    return 'debit';
  }
  if (legacyType === 'paid' || legacyType === 'payment' || legacyType === 'received') {
    return 'credit';
  }

  return null;
}

/**
 * Computes effective due date for a Debit (Dr) entry.
 * Uses entry.dueDate if explicitly set; otherwise entryDate + defaultCreditDays.
 */
export function computeEntryDueDate(entry, defaultCreditDays = 30) {
  if (entry?.dueDate) {
    const explicit = toIsoDay(entry.dueDate);
    if (explicit) return explicit;
  }
  const baseIso = toIsoDay(entry?.dateIso || entry?.date || entry?.createdAt);
  if (!baseIso) return null;
  const days = Number.isFinite(Number(defaultCreditDays)) ? Math.max(0, Number(defaultCreditDays)) : 30;
  return addDaysIso(baseIso, days);
}

/**
 * Returns inclusive { startIso, endIso, totalDays, groupBy } for standard or custom periods.
 */
export function getPeriodRange(periodKey = 'month', customStart = null, customEnd = null, now = new Date()) {
  const todayIso = toIsoDay(now);
  const [y, m] = todayIso.split('-').map(Number);

  let startIso = todayIso;
  let endIso = todayIso;

  switch (periodKey) {
    case 'today':
      startIso = todayIso;
      endIso = todayIso;
      break;
    case 'week':
      startIso = addDaysIso(todayIso, -6);
      endIso = todayIso;
      break;
    case 'month':
      startIso = `${y}-${String(m).padStart(2, '0')}-01`;
      endIso = todayIso;
      break;
    case 'last_month': {
      const prevYear = m === 1 ? y - 1 : y;
      const prevMonth = m === 1 ? 12 : m - 1;
      const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
      startIso = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`;
      endIso = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      break;
    }
    case 'year':
      startIso = `${y}-01-01`;
      endIso = todayIso;
      break;
    case 'custom': {
      const s = toIsoDay(customStart) || addDaysIso(todayIso, -29);
      const e = toIsoDay(customEnd) || todayIso;
      startIso = s <= e ? s : e;
      endIso = s <= e ? e : s;
      break;
    }
    default:
      startIso = `${y}-${String(m).padStart(2, '0')}-01`;
      endIso = todayIso;
  }

  const totalDays = Math.max(1, diffDaysIso(startIso, endIso) + 1);
  return {
    periodKey,
    startIso,
    endIso,
    totalDays,
    groupBy: totalDays > 60 ? 'month' : 'day',
  };
}

function getEntryDateIso(entry, fallbackIso) {
  return toIsoDay(entry?.dateIso || entry?.date || entry?.createdAt) || fallbackIso;
}

/**
 * Computes all-time customer dues, advances, overdue amounts (FIFO payment allocation),
 * ageing buckets, and running-balance khata ledger rows per customer.
 */
export function computeCustomerDues(entries = [], options = {}) {
  const referenceIso = toIsoDay(options.referenceDate || new Date());
  const defaultCreditDays = Number.isFinite(Number(options.defaultCreditDays))
    ? Number(options.defaultCreditDays)
    : 30;

  const byCustomer = new Map();

  const normalized = (entries || [])
    .map((e, idx) => {
      const side = resolveAccountingSide(e);
      const amount = Number(e?.amount || 0);
      const customerName = String(e?.customerName || '').trim();
      if (!side || !customerName || !(amount >= 0)) return null;
      const dateIso = getEntryDateIso(e, referenceIso);
      const dueDateIso = side === 'debit' ? computeEntryDueDate({ ...e, dateIso }, defaultCreditDays) : null;
      return {
        id: e.id || `row-${idx}`,
        customerName,
        side,
        amount,
        dateIso,
        dueDateIso,
        note: e.note || e.sourceClause || (side === 'debit' ? 'Credit sale (Dr)' : 'Payment received (Cr)'),
        createdAt: e.createdAt || `${dateIso}T12:00:00.000Z`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.dateIso !== b.dateIso) return a.dateIso < b.dateIso ? -1 : 1;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });

  for (const row of normalized) {
    const key = row.customerName.toLowerCase();
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        customerName: row.customerName,
        rows: [],
      });
    }
    byCustomer.get(key).rows.push(row);
  }

  const ageingBuckets = {
    notYetDue: 0,
    days1to7: 0,
    days8to30: 0,
    days31plus: 0,
  };

  const customers = [];
  let totalDue = 0;
  let totalOverdue = 0;
  let totalAdvance = 0;

  for (const { customerName, rows } of byCustomer.values()) {
    let totalDebit = 0;
    let totalCredit = 0;
    let runningBalance = 0;
    let lastPaymentDate = null;
    const debitsQueue = [];
    const ledgerRows = [];

    for (const r of rows) {
      if (r.side === 'debit') {
        totalDebit += r.amount;
        runningBalance += r.amount;
        debitsQueue.push({
          remaining: r.amount,
          dueDateIso: r.dueDateIso,
          dateIso: r.dateIso,
        });
      } else {
        totalCredit += r.amount;
        runningBalance -= r.amount;
        if (!lastPaymentDate || r.dateIso > lastPaymentDate) {
          lastPaymentDate = r.dateIso;
        }
      }

      ledgerRows.push({
        id: r.id,
        dateIso: r.dateIso,
        dueDateIso: r.dueDateIso,
        note: r.note,
        debit: r.side === 'debit' ? r.amount : 0,
        credit: r.side === 'credit' ? r.amount : 0,
        balance: runningBalance,
      });
    }

    // Apply total Credit payments FIFO against oldest Debits to find exact unpaid overdue amounts
    let creditToAllocate = totalCredit;
    for (const dItem of debitsQueue) {
      if (creditToAllocate <= 0) break;
      const paid = Math.min(dItem.remaining, creditToAllocate);
      dItem.remaining -= paid;
      creditToAllocate -= paid;
    }

    let overdueAmount = 0;
    let daysOverdue = 0;

    for (const dItem of debitsQueue) {
      if (dItem.remaining <= 0) continue;
      const overdueDays = dItem.dueDateIso ? diffDaysIso(dItem.dueDateIso, referenceIso) : 0;
      if (overdueDays > 0) {
        overdueAmount += dItem.remaining;
        if (overdueDays > daysOverdue) daysOverdue = overdueDays;

        if (overdueDays <= 7) ageingBuckets.days1to7 += dItem.remaining;
        else if (overdueDays <= 30) ageingBuckets.days8to30 += dItem.remaining;
        else ageingBuckets.days31plus += dItem.remaining;
      } else {
        ageingBuckets.notYetDue += dItem.remaining;
      }
    }

    const rawBalance = totalDebit - totalCredit;
    const dueAmount = rawBalance;
    const positiveDue = rawBalance > 0 ? rawBalance : 0;
    const advanceAmount = rawBalance < 0 ? Math.abs(rawBalance) : 0;

    totalDue += positiveDue;
    totalOverdue += overdueAmount;
    totalAdvance += advanceAmount;

    customers.push({
      customerName,
      totalDebit,
      totalCredit,
      dueAmount,
      positiveDue,
      advanceAmount,
      isAdvance: advanceAmount > 0,
      lastPaymentDate,
      overdueAmount,
      daysOverdue,
      ledgerRows,
    });
  }

  const dueCustomers = customers
    .filter((c) => c.positiveDue > 0)
    .sort((a, b) => b.positiveDue - a.positiveDue);

  const advanceCustomers = customers
    .filter((c) => c.advanceAmount > 0)
    .sort((a, b) => b.advanceAmount - a.advanceAmount);

  return {
    totalDue,
    totalOverdue,
    totalAdvance,
    ageingBuckets,
    customers,
    topDueCustomers: dueCustomers.slice(0, 10),
    dueCustomers,
    advanceCustomers,
  };
}

/**
 * Computes Period Balance Statement:
 * openingBalance + debitInPeriod - creditInPeriod = closingBalance
 * collectionRate = creditInPeriod / (openingBalance + debitInPeriod) (null if denominator === 0)
 * netCashCleared = cashSalesInPeriod + creditInPeriod
 */
export function computePeriodStatement(entries = [], range, cashSales = []) {
  const startIso = toIsoDay(range?.startIso);
  const endIso = toIsoDay(range?.endIso);

  let openingBalance = 0;
  let debitInPeriod = 0;
  let creditInPeriod = 0;

  for (const e of entries || []) {
    const side = resolveAccountingSide(e);
    const amount = Number(e?.amount || 0);
    if (!side || !(amount >= 0)) continue;
    const dateIso = toIsoDay(e.dateIso || e.date || e.createdAt);
    if (!dateIso) continue;

    if (dateIso < startIso) {
      openingBalance += side === 'debit' ? amount : -amount;
    } else if (dateIso >= startIso && dateIso <= endIso) {
      if (side === 'debit') debitInPeriod += amount;
      else creditInPeriod += amount;
    }
  }

  const closingBalance = openingBalance + debitInPeriod - creditInPeriod;
  const denominator = openingBalance + debitInPeriod;
  const collectionRate = denominator === 0 ? null : creditInPeriod / denominator;

  let cashSalesInPeriod = 0;
  for (const s of cashSales || []) {
    if (String(s?.kind || '').toLowerCase() !== 'sale') continue;
    const dateIso = toIsoDay(s.dateIso || s.date || s.createdAt);
    if (!dateIso || dateIso < startIso || dateIso > endIso) continue;
    cashSalesInPeriod += Number(s.revenue ?? s.amount ?? 0);
  }

  const netCashCleared = cashSalesInPeriod + creditInPeriod;

  return {
    startIso,
    endIso,
    openingBalance,
    debitInPeriod,
    creditInPeriod,
    closingBalance,
    collectionRate,
    cashSalesInPeriod,
    netCashCleared,
  };
}

/**
 * Builds Profit & Loss time-series buckets (daily when range <= 60 days, monthly when > 60 days).
 * Profit = Revenue - COGS - Expenses.
 */
export function computeProfitLossSeries(records = [], range) {
  const startIso = toIsoDay(range?.startIso);
  const endIso = toIsoDay(range?.endIso);
  const totalDays = Math.max(1, diffDaysIso(startIso, endIso) + 1);
  const groupBy = range?.groupBy || (totalDays > 60 ? 'month' : 'day');

  const bucketKeys = [];
  if (groupBy === 'day') {
    for (let i = 0; i < totalDays; i += 1) {
      bucketKeys.push(addDaysIso(startIso, i));
    }
  } else {
    const [sy, sm] = startIso.split('-').map(Number);
    const [ey, em] = endIso.split('-').map(Number);
    let y = sy;
    let m = sm;
    while (y < ey || (y === ey && m <= em)) {
      bucketKeys.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }

  const map = new Map();
  for (const key of bucketKeys) {
    map.set(key, {
      key,
      revenue: 0,
      cogs: 0,
      expenses: 0,
      profit: 0,
      cumulativeProfit: 0,
      hasActivity: false,
    });
  }

  let hasAnyData = false;

  for (const rec of records || []) {
    const dateIso = toIsoDay(rec?.dateIso || rec?.date || rec?.createdAt);
    if (!dateIso || dateIso < startIso || dateIso > endIso) continue;

    const bucketKey = groupBy === 'month' ? dateIso.slice(0, 7) : dateIso;
    const bucket = map.get(bucketKey);
    if (!bucket) continue;

    const kind = String(rec.kind || rec.type || '').toLowerCase();

    if (kind === 'sale' || kind === 'cash_sale' || kind === 'credit_sale') {
      const rev = Number(rec.revenue ?? rec.amount ?? 0);
      const cost = Number(rec.cogs ?? rec.cost ?? 0);
      bucket.revenue += rev;
      bucket.cogs += cost;
      bucket.hasActivity = true;
      hasAnyData = true;
    } else if (kind === 'expense') {
      const exp = Number(rec.expenses ?? rec.amount ?? 0);
      bucket.expenses += exp;
      bucket.hasActivity = true;
      hasAnyData = true;
    } else if ('revenue' in rec || 'cogs' in rec || 'expenses' in rec) {
      bucket.revenue += Number(rec.revenue || 0);
      bucket.cogs += Number(rec.cogs || 0);
      bucket.expenses += Number(rec.expenses || 0);
      bucket.hasActivity = true;
      hasAnyData = true;
    }
  }

  let cumulative = 0;
  let totalRevenue = 0;
  let totalCogs = 0;
  let totalExpenses = 0;

  const series = bucketKeys.map((key) => {
    const b = map.get(key);
    b.profit = b.revenue - b.cogs - b.expenses;
    cumulative += b.profit;
    b.cumulativeProfit = cumulative;
    totalRevenue += b.revenue;
    totalCogs += b.cogs;
    totalExpenses += b.expenses;
    return b;
  });

  const netProfit = totalRevenue - totalCogs - totalExpenses;

  return {
    groupBy,
    startIso,
    endIso,
    hasAnyData,
    totalRevenue,
    totalCogs,
    totalExpenses,
    netProfit,
    series,
  };
}

/**
 * Pure stock metrics computation powering the Scrolltide Lime-Metrics Stock cards.
 */
export function computeStockMetrics(stockItems = []) {
  const items = Array.isArray(stockItems) ? stockItems : [];

  let inStock = 0;
  let lowStock = 0;
  let outOfStock = 0;
  let totalValuation = 0;

  for (const item of items) {
    const qty = Number(item.qty || 0);
    const reorderAt = Number(item.reorderAt ?? 10);
    const cost = Number(item.costPrice || 0);
    totalValuation += qty * cost;

    if (qty <= 0) outOfStock += 1;
    else if (qty <= reorderAt) lowStock += 1;
    else inStock += 1;
  }

  const topMovers = [...items]
    .sort((a, b) => Number(b.soldUnits || 0) - Number(a.soldUnits || 0))
    .slice(0, 5)
    .map((item) => ({
      name: item.name,
      soldUnits: Number(item.soldUnits || 0),
      marginPct:
        Number(item.sellPrice || 0) > 0
          ? Math.round(((Number(item.sellPrice) - Number(item.costPrice || 0)) / Number(item.sellPrice)) * 100)
          : 0,
    }));

  // 7-step valuation series anchored to current totalValuation
  const multipliers = [0.84, 0.88, 0.86, 0.93, 0.91, 0.97, 1.0];
  const valuationSteps = multipliers.map((m, idx) => ({
    label: `D${idx + 1}`,
    value: totalValuation * m,
  }));

  return {
    totalSkus: items.length,
    inStock,
    lowStock,
    outOfStock,
    totalValuation,
    topMovers,
    valuationSteps,
  };
}
