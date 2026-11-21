/**
 * TalkLedger Reports Tab Controller
 * - 'Dues and collections' Card (pure calculations from public/pnl.js)
 * - Plain-SVG Profit/Loss Graph (no chart libraries, RTL-aware, a11y table + tooltip)
 * - Scrolltide #s-lime-metrics Stocks Section (3 plain-SVG charts: Bar, Donut, Stepped Area)
 */

import {
  computeCustomerDues,
  computePeriodStatement,
  computeProfitLossSeries,
  computeStockMetrics,
  getPeriodRange,
  toIsoDay,
} from '../pnl.js';
import {
  formatCurrencyInr,
  formatLocalizedDate,
  formatNumber,
  isRtl,
  t,
} from './i18n.js';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class ReportsController {
  constructor(app) {
    this.app = app;
    this.periodKey = 'month';
    this.customStart = null;
    this.customEnd = null;
    this.selectedKhataCustomer = null;
    this.bound = false;
  }

  init() {
    this.container = document.getElementById('reportsRoot');
    this.khataBackdrop = document.getElementById('khataModalBackdrop');
    this.khataContent = document.getElementById('khataModalContent');
    this.saleModalBackdrop = document.getElementById('saleModalBackdrop');
    this.saleForm = document.getElementById('saleEntryForm');

    if (!this.bound) {
      this.bound = true;
      this.bindModals();
    }
    this.render();
  }

  bindModals() {
    this.khataBackdrop?.addEventListener('click', (e) => {
      if (e.target === this.khataBackdrop) this.closeKhataModal();
    });
    document.getElementById('closeKhataModalBtn')?.addEventListener('click', () => this.closeKhataModal());

    this.saleModalBackdrop?.addEventListener('click', (e) => {
      if (e.target === this.saleModalBackdrop) this.closeSaleModal();
    });
    document.getElementById('cancelSaleModalBtn')?.addEventListener('click', () => this.closeSaleModal());

    const kindSel = document.getElementById('saleKindSelect');
    const syncFields = () => {
      const kind = kindSel?.value || 'sale';
      document.getElementById('saleCogsGroup').hidden = kind !== 'sale';
      document.getElementById('saleCustomerGroup').hidden = kind !== 'debit';
      document.getElementById('saleDueDateGroup').hidden = kind !== 'debit';
    };
    kindSel?.addEventListener('change', syncFields);

    this.saleForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const kind = document.getElementById('saleKindSelect').value;
      const amount = Number(document.getElementById('saleAmountInput').value);
      const cogs = Number(document.getElementById('saleCogsInput').value || 0);
      const dateIso = document.getElementById('saleDateInput').value || toIsoDay(new Date());
      const note = document.getElementById('saleNoteInput').value.trim();
      const customerName = document.getElementById('saleCustomerInput').value.trim();
      const dueDate = document.getElementById('saleDueDateInput').value || null;

      if (!(amount > 0)) {
        this.app.showToast('Please enter a valid positive amount.');
        return;
      }

      if (kind === 'debit') {
        if (!customerName) {
          this.app.showToast('Please enter a customer name for Debit (Dr).');
          return;
        }
        await this.app.addManualDebitEntry({ customerName, amount, dateIso, dueDate, note });
      } else {
        await this.app.addBusinessRecord({
          id: `biz-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind,
          dateIso,
          revenue: kind === 'sale' ? amount : 0,
          cogs: kind === 'sale' ? Math.max(0, cogs) : 0,
          amount,
          note: note || (kind === 'sale' ? 'Cash sale' : 'Shop expense'),
          createdAt: new Date().toISOString(),
        });
      }

      this.saleForm.reset();
      this.closeSaleModal();
      this.render();
    });
  }

  openSaleModal(defaultKind = 'sale') {
    if (!this.saleModalBackdrop) return;
    const kindSel = document.getElementById('saleKindSelect');
    const dateInput = document.getElementById('saleDateInput');
    if (kindSel) {
      kindSel.value = defaultKind;
      kindSel.dispatchEvent(new Event('change'));
    }
    if (dateInput) dateInput.value = toIsoDay(new Date());
    this.saleModalBackdrop.hidden = false;
    document.getElementById('saleAmountInput')?.focus();
  }

  closeSaleModal() {
    if (this.saleModalBackdrop) this.saleModalBackdrop.hidden = true;
  }

  openKhataModal(customerRecord) {
    if (!this.khataBackdrop || !this.khataContent) return;
    this.selectedKhataCustomer = customerRecord;

    const rowsHtml = customerRecord.ledgerRows
      .map(
        (r) => `
          <tr>
            <td class="tabular">${esc(formatLocalizedDate(r.dateIso, { day: '2-digit', month: 'short', year: '2-digit' }))}</td>
            <td>${esc(r.note)}</td>
            <td class="tabular col-dr">${r.debit > 0 ? esc(formatCurrencyInr(r.debit)) : '—'}</td>
            <td class="tabular col-cr">${r.credit > 0 ? esc(formatCurrencyInr(r.credit)) : '—'}</td>
            <td class="tabular col-bal">${r.balance >= 0 ? esc(formatCurrencyInr(r.balance)) : `Cr ${esc(formatCurrencyInr(Math.abs(r.balance)))}`}</td>
          </tr>
        `
      )
      .join('');

    this.khataContent.innerHTML = `
      <div class="khata-summary-bar">
        <div>
          <strong>${esc(customerRecord.customerName)}</strong>
          <span class="khata-sub">${esc(t('reports.dues.khataTitle'))}</span>
        </div>
        <div class="khata-totals tabular">
          <span>${esc(t('reports.terms.debit'))}: <strong>${esc(formatCurrencyInr(customerRecord.totalDebit))}</strong></span>
          <span>${esc(t('reports.terms.credit'))}: <strong>${esc(formatCurrencyInr(customerRecord.totalCredit))}</strong></span>
          <span>${esc(t('reports.terms.dueAmount'))}: <strong>${customerRecord.isAdvance ? `${esc(t('reports.terms.advance'))} ${esc(formatCurrencyInr(customerRecord.advanceAmount))}` : esc(formatCurrencyInr(customerRecord.positiveDue))}</strong></span>
        </div>
      </div>
      <div class="khata-table-wrap">
        <table class="khata-table">
          <thead>
            <tr>
              <th>${esc(t('reports.dues.colDate'))}</th>
              <th>${esc(t('reports.dues.colNote'))}</th>
              <th>${esc(t('reports.dues.colDebit'))}</th>
              <th>${esc(t('reports.dues.colCredit'))}</th>
              <th>${esc(t('reports.dues.colBalance'))}</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
    this.khataBackdrop.hidden = false;
  }

  closeKhataModal() {
    if (this.khataBackdrop) this.khataBackdrop.hidden = true;
    this.selectedKhataCustomer = null;
  }

  async shareReminder(customer) {
    const amountText = formatCurrencyInr(customer.positiveDue);
    const message = t('reports.dues.remindMessage', {
      name: customer.customerName,
      amount: amountText,
    });

    // Always let the user confirm/send via OS share sheet or pre-filled compose — NEVER auto-send
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Voice Khata',
          text: message,
        });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }

    try {
      await navigator.clipboard?.writeText(message);
      this.app.showToast(`Reminder copied (never sent automatically): "${message}"`);
    } catch {
      this.app.showToast(message);
    }
  }

  render() {
    if (!this.container) return;

    const now = new Date();
    const defaultCreditDays = Number(this.app.state.settings.defaultCreditDays ?? 30);
    const range = getPeriodRange(this.periodKey, this.customStart, this.customEnd, now);

    const dues = computeCustomerDues(this.app.state.entries, {
      referenceDate: now,
      defaultCreditDays,
    });
    const bizRecords = this.app.state.businessRecords || [];
    const statement = computePeriodStatement(this.app.state.entries, range, bizRecords);
    const pnl = computeProfitLossSeries(bizRecords, range);
    const stockMetrics = computeStockMetrics(this.app.state.stocks || []);

    const collectionPct =
      statement.collectionRate === null
        ? null
        : Math.max(0, Math.min(100, Math.round(statement.collectionRate * 100)));

    const periods = ['today', 'week', 'month', 'last_month', 'year', 'custom'];

    this.container.innerHTML = `
      <!-- Period Selector & Default Credit Period Setting -->
      <div class="reports-controls-bar">
        <div class="period-selector" role="group" aria-label="Reporting period">
          ${periods
            .map(
              (p) =>
                `<button type="button" class="filter-pill ${this.periodKey === p ? 'is-active' : ''}" data-period="${p}">${esc(t(`reports.period.${p}`))}</button>`
            )
            .join('')}
        </div>

        <div class="reports-right-controls">
          <label class="credit-days-setting">
            <span>${esc(t('reports.settings.creditPeriod'))}</span>
            <input type="number" min="1" max="365" value="${defaultCreditDays}" id="defaultCreditDaysInput" class="days-input tabular" />
          </label>
          <button type="button" class="btn-primary" id="openAddSaleModalBtn">${esc(t('reports.dues.addSaleBtn'))}</button>
        </div>
      </div>

      ${
        this.periodKey === 'custom'
          ? `
        <div class="custom-range-row">
          <label>
            <span>${esc(t('reports.period.from'))}</span>
            <input type="date" id="customStartInput" value="${esc(range.startIso)}" />
          </label>
          <label>
            <span>${esc(t('reports.period.to'))}</span>
            <input type="date" id="customEndInput" value="${esc(range.endIso)}" />
          </label>
        </div>
      `
          : ''
      }

      <!-- 1. DUES AND COLLECTIONS CARD -->
      <section class="report-card" aria-label="${esc(t('reports.dues.cardTitle'))}">
        <div class="report-card-head">
          <div>
            <h3>${esc(t('reports.dues.cardTitle'))}</h3>
            <p class="report-card-sub">${esc(formatLocalizedDate(range.startIso))} – ${esc(formatLocalizedDate(range.endIso))}</p>
          </div>
          <div class="net-cash-badge tabular">
            <span>${esc(t('reports.terms.netCashCleared'))}</span>
            <strong>${esc(formatCurrencyInr(statement.netCashCleared))}</strong>
            <small>${esc(t('reports.terms.netCashClearedSub'))}</small>
          </div>
        </div>

        <!-- Four Large INR Numbers -->
        <div class="dues-kpi-grid">
          <div class="dues-kpi-tile dues-kpi-tile--due">
            <span class="dues-kpi-label">${esc(t('reports.terms.totalDue'))}</span>
            <strong class="dues-kpi-val tabular">${esc(formatCurrencyInr(dues.totalDue))}</strong>
            <span class="dues-kpi-sub">${esc(t('reports.terms.totalDueSub'))}</span>
          </div>
          <div class="dues-kpi-tile dues-kpi-tile--overdue">
            <span class="dues-kpi-label">${esc(t('reports.terms.overdue'))}</span>
            <strong class="dues-kpi-val tabular">${esc(formatCurrencyInr(dues.totalOverdue))}</strong>
            <span class="dues-kpi-sub">${esc(t('reports.terms.overdueSub'))}</span>
          </div>
          <div class="dues-kpi-tile dues-kpi-tile--dr">
            <span class="dues-kpi-label">${esc(t('reports.terms.debitInPeriod'))}</span>
            <strong class="dues-kpi-val tabular">${esc(formatCurrencyInr(statement.debitInPeriod))}</strong>
            <span class="dues-kpi-sub">${esc(t('reports.terms.debitSub'))}</span>
          </div>
          <div class="dues-kpi-tile dues-kpi-tile--cr">
            <span class="dues-kpi-label">${esc(t('reports.terms.creditInPeriod'))}</span>
            <strong class="dues-kpi-val tabular">${esc(formatCurrencyInr(statement.creditInPeriod))}</strong>
            <span class="dues-kpi-sub">${esc(t('reports.terms.creditSub'))}</span>
          </div>
        </div>

        <!-- Statement Strip: Opening + Debit - Credit = Closing -->
        <div class="statement-strip" aria-label="${esc(t('reports.dues.statementTitle'))}">
          <div class="stmt-term">
            <span class="stmt-label">${esc(t('reports.terms.openingBalance'))}</span>
            <strong class="tabular">${esc(formatCurrencyInr(statement.openingBalance, { signed: true }))}</strong>
          </div>
          <span class="stmt-op" aria-hidden="true">+</span>
          <div class="stmt-term">
            <span class="stmt-label">${esc(t('reports.terms.debit'))}</span>
            <strong class="tabular">${esc(formatCurrencyInr(statement.debitInPeriod))}</strong>
          </div>
          <span class="stmt-op" aria-hidden="true">&minus;</span>
          <div class="stmt-term">
            <span class="stmt-label">${esc(t('reports.terms.credit'))}</span>
            <strong class="tabular">${esc(formatCurrencyInr(statement.creditInPeriod))}</strong>
          </div>
          <span class="stmt-op" aria-hidden="true">=</span>
          <div class="stmt-term stmt-term--closing">
            <span class="stmt-label">${esc(t('reports.terms.closingBalance'))}</span>
            <strong class="tabular">${esc(formatCurrencyInr(statement.closingBalance, { signed: true }))}</strong>
          </div>
        </div>

        <!-- Collection Rate Progress Bar -->
        <div class="collection-bar-box">
          <div class="collection-bar-head">
            <span>${esc(t('reports.terms.collectionRate'))}</span>
            <strong class="tabular">${collectionPct === null ? '—' : `${formatNumber(collectionPct)}%`}</strong>
          </div>
          <div class="collection-track" role="progressbar" aria-valuenow="${collectionPct ?? 0}" aria-valuemin="0" aria-valuemax="100">
            <div class="collection-fill" style="width: ${collectionPct ?? 0}%"></div>
          </div>
        </div>

        <!-- Ageing Buckets -->
        <div class="ageing-section">
          <h4 class="report-subhead">${esc(t('reports.dues.ageingTitle'))}</h4>
          <div class="ageing-grid">
            <div class="ageing-bucket">
              <span>${esc(t('reports.dues.notYetDue'))}</span>
              <strong class="tabular">${esc(formatCurrencyInr(dues.ageingBuckets.notYetDue))}</strong>
            </div>
            <div class="ageing-bucket ageing-bucket--warn">
              <span>${esc(t('reports.dues.days1to7'))}</span>
              <strong class="tabular">${esc(formatCurrencyInr(dues.ageingBuckets.days1to7))}</strong>
            </div>
            <div class="ageing-bucket ageing-bucket--med">
              <span>${esc(t('reports.dues.days8to30'))}</span>
              <strong class="tabular">${esc(formatCurrencyInr(dues.ageingBuckets.days8to30))}</strong>
            </div>
            <div class="ageing-bucket ageing-bucket--high">
              <span>${esc(t('reports.dues.days31plus'))}</span>
              <strong class="tabular">${esc(formatCurrencyInr(dues.ageingBuckets.days31plus))}</strong>
            </div>
          </div>
        </div>

        <!-- Top 10 Customers by Due Amount -->
        <div class="top-dues-section">
          <div class="report-subhead-row">
            <h4 class="report-subhead">${esc(t('reports.dues.topCustomers'))}</h4>
            <span class="report-hint">${esc(t('reports.terms.dueAmountSub'))}</span>
          </div>
          ${
            dues.topDueCustomers.length === 0
              ? `<p class="report-empty-note">${esc(t('reports.dues.noDueCustomers'))}</p>`
              : `<ul class="dues-customer-list">
                  ${dues.topDueCustomers
                    .map(
                      (c) => `
                        <li class="dues-customer-row">
                          <button type="button" class="dues-customer-main" data-open-khata="${esc(c.customerName)}">
                            <div class="dues-customer-name-line">
                              <strong>${esc(c.customerName)}</strong>
                              ${
                                c.overdueAmount > 0
                                  ? `<span class="overdue-pill tabular">${esc(t('reports.dues.overdueDays', { days: c.daysOverdue }))}</span>`
                                  : ''
                              }
                            </div>
                            <div class="dues-customer-sub tabular">
                              <span>Dr ${esc(formatCurrencyInr(c.totalDebit))}</span>
                              <span>&middot;</span>
                              <span>Cr ${esc(formatCurrencyInr(c.totalCredit))}</span>
                            </div>
                          </button>
                          <div class="dues-customer-right">
                            <strong class="dues-amount tabular">${esc(formatCurrencyInr(c.positiveDue))}</strong>
                            <button type="button" class="remind-btn" data-remind-customer="${esc(c.customerName)}">${esc(t('reports.dues.remind'))}</button>
                          </div>
                        </li>
                      `
                    )
                    .join('')}
                </ul>`
          }
        </div>

        <!-- Advance (Cr balance) Separate List -->
        <div class="advance-section">
          <div class="report-subhead-row">
            <h4 class="report-subhead">${esc(t('reports.dues.advanceTitle'))}</h4>
            <span class="report-hint">${esc(t('reports.terms.advanceSub'))}</span>
          </div>
          ${
            dues.advanceCustomers.length === 0
              ? `<p class="report-empty-note">${esc(t('reports.dues.noAdvanceCustomers'))}</p>`
              : `<ul class="advance-list">
                  ${dues.advanceCustomers
                    .map(
                      (c) => `
                        <li class="advance-row">
                          <button type="button" class="advance-name-btn" data-open-khata="${esc(c.customerName)}">${esc(c.customerName)}</button>
                          <span class="advance-badge tabular">${esc(t('reports.terms.advance'))}: ${esc(formatCurrencyInr(c.advanceAmount))}</span>
                        </li>
                      `
                    )
                    .join('')}
                </ul>`
          }
        </div>
      </section>

      <!-- 2. PROFIT & LOSS GRAPH (PLAIN SVG, ZERO LIBRARIES) -->
      <section class="report-card" aria-label="${esc(t('reports.pnl.title'))}">
        <div class="report-card-head">
          <div>
            <h3>${esc(t('reports.pnl.title'))}</h3>
            <p class="report-card-sub">${esc(t('reports.pnl.subtitle'))}</p>
          </div>
          <div class="pnl-net-badge ${pnl.netProfit > 0 ? 'is-profit' : pnl.netProfit < 0 ? 'is-loss' : ''} tabular">
            ${
              pnl.netProfit > 0
                ? `<span aria-hidden="true">&#9650;</span> ${esc(t('reports.pnl.netProfit', { amount: formatCurrencyInr(pnl.netProfit) }))}`
                : pnl.netProfit < 0
                ? `<span aria-hidden="true">&#9660;</span> ${esc(t('reports.pnl.netLoss', { amount: formatCurrencyInr(Math.abs(pnl.netProfit)) }))}`
                : esc(t('reports.pnl.netEven', { amount: formatCurrencyInr(0) }))
            }
          </div>
        </div>

        ${this.renderPnlSvgBlock(pnl)}

        <p class="bookkeeping-disclaimer">${esc(t('reports.disclaimer'))}</p>
      </section>

      <!-- 3. SCROLLTIDE #s-lime-metrics STOCKS SECTION -->
      <section class="lime-stocks-section" aria-label="Shop Stocks and Margins">
        <div class="lime-headline-row">
          <h3 class="lime-headline">
            ${esc(t('reports.stocks.headlineBefore'))}
            <span class="lime-highlight">${esc(t('reports.stocks.headlineHighlight1'))}</span>
            ${esc(t('reports.stocks.headlineMid'))}
            <span class="lime-highlight">${esc(t('reports.stocks.headlineHighlight2'))}</span>
            ${esc(t('reports.stocks.headlineAfter'))}
          </h3>
          <span class="lime-valuation-pill tabular">${esc(formatCurrencyInr(stockMetrics.totalValuation))}</span>
        </div>

        <div class="lime-cards-grid">
          <!-- Card 1: Bar Series -->
          <article class="lime-metric-card">
            <div class="lime-card-head">
              <h4>${esc(t('reports.stocks.cardBarTitle'))}</h4>
              <p>${esc(t('reports.stocks.cardBarSub'))}</p>
            </div>
            ${this.renderStockBarSvg(stockMetrics.topMovers)}
          </article>

          <!-- Card 2: Donut Chart -->
          <article class="lime-metric-card">
            <div class="lime-card-head">
              <h4>${esc(t('reports.stocks.cardDonutTitle'))}</h4>
              <p>${esc(t('reports.stocks.cardDonutSub'))}</p>
            </div>
            ${this.renderStockDonutSvg(stockMetrics)}
          </article>

          <!-- Card 3: Stepped Area Chart -->
          <article class="lime-metric-card">
            <div class="lime-card-head">
              <h4>${esc(t('reports.stocks.cardAreaTitle'))}</h4>
              <p>${esc(t('reports.stocks.cardAreaSub'))}</p>
            </div>
            ${this.renderStockSteppedAreaSvg(stockMetrics.valuationSteps)}
          </article>
        </div>

        <!-- Interactive Stock Inventory Table + Add Form -->
        <div class="stock-inventory-card">
          <form class="stock-add-form" id="addStockForm" autocomplete="off">
            <input type="text" id="stockNameInput" placeholder="${esc(t('reports.stocks.skuName'))}" required />
            <input type="number" id="stockQtyInput" min="0" placeholder="${esc(t('reports.stocks.qty'))}" required />
            <input type="number" id="stockCostInput" min="0" step="0.01" placeholder="${esc(t('reports.stocks.costPrice'))}" required />
            <input type="number" id="stockSellInput" min="0" step="0.01" placeholder="${esc(t('reports.stocks.sellPrice'))}" required />
            <button type="submit" class="btn-primary">${esc(t('reports.stocks.addStock'))}</button>
          </form>

          <ul class="stock-list">
            ${(this.app.state.stocks || [])
              .map((s) => {
                const status = s.qty <= 0 ? 'out' : s.qty <= (s.reorderAt ?? 10) ? 'low' : 'ok';
                const statusLabel =
                  status === 'out'
                    ? t('reports.stocks.outOfStock')
                    : status === 'low'
                    ? t('reports.stocks.lowStock')
                    : t('reports.stocks.inStock');
                const margin =
                  s.sellPrice > 0 ? Math.round(((s.sellPrice - s.costPrice) / s.sellPrice) * 100) : 0;
                return `
                  <li class="stock-row">
                    <div>
                      <strong>${esc(s.name)}</strong>
                      <span class="stock-row-sub tabular">${esc(formatCurrencyInr(s.costPrice))} &rarr; ${esc(formatCurrencyInr(s.sellPrice))} (${margin}% margin)</span>
                    </div>
                    <div class="stock-row-right">
                      <span class="stock-status-pill stock-status-pill--${status} tabular">${s.qty} &middot; ${esc(statusLabel)}</span>
                      <button type="button" class="restock-btn" data-restock-id="${esc(s.id)}">${esc(t('reports.stocks.restock'))}</button>
                    </div>
                  </li>
                `;
              })
              .join('')}
          </ul>
        </div>
      </section>
    `;

    this.bindRenderedHandlers(dues, pnl);
  }

  renderPnlSvgBlock(pnl) {
    if (!pnl.hasAnyData) {
      return `
        <div class="pnl-empty-state">
          <h4>${esc(t('reports.pnl.emptyTitle'))}</h4>
          <p>${esc(t('reports.pnl.emptyCopy'))}</p>
          <button type="button" class="btn-primary" id="pnlEmptyAddBtn">${esc(t('reports.pnl.addFirstSale'))}</button>
        </div>
      `;
    }

    const rtl = isRtl();
    const bars = pnl.series;
    const count = bars.length;
    const barSlot = Math.max(38, Math.min(58, Math.floor(620 / Math.max(count, 1))));
    const padLeft = 64;
    const padRight = 24;
    const padTop = 28;
    const padBottom = 42;
    const chartH = 190;
    const innerW = Math.max(280, count * barSlot);
    const svgW = padLeft + innerW + padRight;
    const svgH = padTop + chartH + padBottom;

    const maxAbsProfit = Math.max(
      100,
      ...bars.map((b) => Math.abs(b.profit)),
      ...bars.map((b) => Math.abs(b.cumulativeProfit))
    );
    const maxPos = Math.max(maxAbsProfit * 0.2, ...bars.map((b) => Math.max(0, b.profit, b.cumulativeProfit)));
    const maxNeg = Math.max(maxAbsProfit * 0.2, ...bars.map((b) => Math.max(0, -b.profit, -b.cumulativeProfit)));
    const span = maxPos + maxNeg || 1;
    const yZero = padTop + (maxPos / span) * chartH;
    const yScale = (val) => yZero - (val / span) * chartH;

    const xForIndex = (idx) => {
      const visualIdx = rtl ? count - 1 - idx : idx;
      return padLeft + visualIdx * barSlot + barSlot / 2;
    };

    const yTicks = [maxPos, 0, -maxNeg];

    const polyPoints = bars
      .map((b, i) => `${xForIndex(i).toFixed(1)},${yScale(b.cumulativeProfit).toFixed(1)}`)
      .join(' ');

    const ariaSummary = `Profit and loss chart from ${pnl.startIso} to ${pnl.endIso}. Total revenue ${formatCurrencyInr(pnl.totalRevenue)}, COGS ${formatCurrencyInr(pnl.totalCogs)}, expenses ${formatCurrencyInr(pnl.totalExpenses)}, net ${pnl.netProfit >= 0 ? 'profit' : 'loss'} ${formatCurrencyInr(Math.abs(pnl.netProfit))}.`;

    const barEls = bars
      .map((b, i) => {
        const cx = xForIndex(i);
        const bw = Math.min(26, barSlot * 0.56);
        const bx = cx - bw / 2;
        const isLoss = b.profit < 0;
        const yVal = yScale(b.profit);
        const topY = Math.min(yZero, yVal);
        const barH = Math.max(b.hasActivity ? 3 : 0, Math.abs(yVal - yZero));
        const label =
          pnl.groupBy === 'month'
            ? formatLocalizedDate(b.key, { month: 'short', year: '2-digit' })
            : formatLocalizedDate(b.key, { day: 'numeric', month: 'short' });

        const showXLabel = count <= 10 || i % Math.ceil(count / 8) === 0 || i === count - 1;
        const signMark = b.profit > 0 ? '↑' : b.profit < 0 ? '↓' : '';

        return `
          <g class="pnl-bar-group" tabindex="0" role="button"
             data-pnl-idx="${i}"
             aria-label="${esc(`${label}: ${b.profit >= 0 ? '+' : '-'}${formatCurrencyInr(Math.abs(b.profit))}`)}">
            <rect x="${(cx - barSlot / 2).toFixed(1)}" y="${padTop}" width="${barSlot}" height="${chartH}" fill="transparent" />
            ${
              barH > 0
                ? `<rect x="${bx.toFixed(1)}" y="${topY.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" rx="4"
                     fill="${isLoss ? 'url(#lossStripePattern)' : 'var(--profit)'}"
                     stroke="${isLoss ? 'var(--loss)' : 'var(--profit)'}" stroke-width="1.2" />`
                : ''
            }
            ${
              b.hasActivity && Math.abs(b.profit) > 0
                ? `<text x="${cx.toFixed(1)}" y="${(isLoss ? topY + barH + 12 : topY - 6).toFixed(1)}"
                     text-anchor="middle" class="svg-bar-sign ${isLoss ? 'is-loss' : 'is-profit'}">${signMark}</text>`
                : ''
            }
            ${
              showXLabel
                ? `<text x="${cx.toFixed(1)}" y="${svgH - 12}" text-anchor="middle" class="svg-axis-label">${esc(label)}</text>`
                : ''
            }
          </g>
        `;
      })
      .join('');

    const srTableRows = bars
      .filter((b) => b.hasActivity)
      .map(
        (b) => `
          <tr>
            <td>${esc(b.key)}</td>
            <td>${esc(formatCurrencyInr(b.revenue))}</td>
            <td>${esc(formatCurrencyInr(b.cogs))}</td>
            <td>${esc(formatCurrencyInr(b.expenses))}</td>
            <td>${b.profit >= 0 ? '+' : '-'}${esc(formatCurrencyInr(Math.abs(b.profit)))}</td>
          </tr>
        `
      )
      .join('');

    return `
      <div class="pnl-legend-row">
        <span class="pnl-legend-item"><span class="legend-swatch legend-swatch--profit"></span> &#9650; ${esc(t('reports.pnl.profit'))} (+)</span>
        <span class="pnl-legend-item"><span class="legend-swatch legend-swatch--loss"></span> &#9660; ${esc(t('reports.pnl.loss'))} (&minus;)</span>
        <span class="pnl-legend-item"><span class="legend-line"></span> ${esc(t('reports.pnl.cumulative'))}</span>
      </div>

      <div class="pnl-chart-shell">
        <div class="pnl-tooltip" id="pnlTooltip" hidden role="status" aria-live="polite"></div>
        <div class="pnl-scroll-wrap">
          <svg class="pnl-svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" role="img" aria-label="${esc(ariaSummary)}">
            <defs>
              <pattern id="lossStripePattern" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="var(--loss)" fill-opacity="0.22"></rect>
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--loss)" stroke-width="2.4"></line>
              </pattern>
            </defs>

            ${yTicks
              .map((tick) => {
                const y = yScale(tick);
                return `
                  <line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${svgW - padRight}" y2="${y.toFixed(1)}"
                        class="${tick === 0 ? 'svg-zero-line' : 'svg-grid-line'}" />
                  <text x="${padLeft - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="svg-axis-label tabular">
                    ${tick === 0 ? '₹0' : `${tick > 0 ? '+' : '-'}${esc(formatCurrencyInr(Math.abs(tick)))}`}
                  </text>
                `;
              })
              .join('')}

            ${barEls}

            <polyline fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${polyPoints}" />
          </svg>
        </div>
      </div>

      <!-- Screen-reader accessible summary table of the exact chart data -->
      <table class="sr-only">
        <caption>${esc(t('reports.pnl.title'))}</caption>
        <thead>
          <tr>
            <th>${esc(t('reports.dues.colDate'))}</th>
            <th>${esc(t('reports.pnl.revenue'))}</th>
            <th>${esc(t('reports.pnl.cogs'))}</th>
            <th>${esc(t('reports.pnl.expenses'))}</th>
            <th>${esc(t('reports.pnl.profit'))}</th>
          </tr>
        </thead>
        <tbody>${srTableRows}</tbody>
      </table>
    `;
  }

  renderStockBarSvg(topMovers) {
    const items = topMovers.length ? topMovers : [{ name: 'No SKUs', soldUnits: 0 }];
    const maxVal = Math.max(1, ...items.map((i) => i.soldUnits));
    const w = 260;
    const h = 128;
    const barW = 28;
    const gap = Math.floor((w - 20 - items.length * barW) / Math.max(1, items.length));

    const bars = items
      .map((item, idx) => {
        const bh = Math.max(8, Math.round((item.soldUnits / maxVal) * 76));
        const x = 14 + idx * (barW + Math.max(10, gap));
        const y = 96 - bh;
        return `
          <rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="6" fill="${idx === 0 ? 'var(--lime)' : 'var(--lime-muted)'}" />
          <text x="${x + barW / 2}" y="${y - 5}" text-anchor="middle" class="svg-mini-val tabular">${item.soldUnits}</text>
          <text x="${x + barW / 2}" y="116" text-anchor="middle" class="svg-mini-lbl">${esc(item.name.slice(0, 6))}</text>
        `;
      })
      .join('');

    return `<svg class="lime-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Top moving stock units">${bars}</svg>`;
  }

  renderStockDonutSvg(metrics) {
    const total = Math.max(1, metrics.inStock + metrics.lowStock + metrics.outOfStock);
    const r = 38;
    const circ = 2 * Math.PI * r;
    const seg1 = (metrics.inStock / total) * circ;
    const seg2 = (metrics.lowStock / total) * circ;
    const seg3 = (metrics.outOfStock / total) * circ;

    return `
      <div class="lime-donut-wrap">
        <svg class="lime-donut-svg" viewBox="0 0 112 112" role="img" aria-label="Stock health donut chart">
          <circle cx="56" cy="56" r="${r}" fill="none" stroke="var(--border-strong)" stroke-width="14" />
          <circle cx="56" cy="56" r="${r}" fill="none" stroke="var(--lime)" stroke-width="14"
                  stroke-dasharray="${seg1.toFixed(1)} ${(circ - seg1).toFixed(1)}" transform="rotate(-90 56 56)" />
          <circle cx="56" cy="56" r="${r}" fill="none" stroke="var(--accent)" stroke-width="14"
                  stroke-dasharray="${seg2.toFixed(1)} ${(circ - seg2).toFixed(1)}"
                  stroke-dashoffset="${(-seg1).toFixed(1)}" transform="rotate(-90 56 56)" />
          <circle cx="56" cy="56" r="${r}" fill="none" stroke="var(--loss)" stroke-width="14"
                  stroke-dasharray="${seg3.toFixed(1)} ${(circ - seg3).toFixed(1)}"
                  stroke-dashoffset="${(-(seg1 + seg2)).toFixed(1)}" transform="rotate(-90 56 56)" />
          <text x="56" y="54" text-anchor="middle" class="svg-donut-num tabular">${metrics.totalSkus}</text>
          <text x="56" y="68" text-anchor="middle" class="svg-mini-lbl">SKUs</text>
        </svg>
        <div class="lime-donut-legend">
          <div><span class="dot dot--lime"></span> ${esc(t('reports.stocks.inStock'))}: <strong class="tabular">${metrics.inStock}</strong></div>
          <div><span class="dot dot--warn"></span> ${esc(t('reports.stocks.lowStock'))}: <strong class="tabular">${metrics.lowStock}</strong></div>
          <div><span class="dot dot--loss"></span> ${esc(t('reports.stocks.outOfStock'))}: <strong class="tabular">${metrics.outOfStock}</strong></div>
        </div>
      </div>
    `;
  }

  renderStockSteppedAreaSvg(steps) {
    const w = 260;
    const h = 128;
    const padX = 12;
    const topY = 18;
    const baseY = 104;
    const maxV = Math.max(100, ...steps.map((s) => s.value));
    const dx = (w - padX * 2) / Math.max(1, steps.length - 1);

    let lineD = '';
    steps.forEach((s, i) => {
      const x = padX + i * dx;
      const y = baseY - (s.value / maxV) * (baseY - topY);
      if (i === 0) {
        lineD += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
      } else {
        lineD += ` H ${x.toFixed(1)} V ${y.toFixed(1)}`;
      }
    });
    const areaD = `${lineD} V ${baseY} H ${padX} Z`;

    return `
      <svg class="lime-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Stepped inventory valuation trend">
        <defs>
          <linearGradient id="limeAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--lime)" stop-opacity="0.36" />
            <stop offset="100%" stop-color="var(--lime)" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        <path d="${areaD}" fill="url(#limeAreaGrad)" />
        <path d="${lineD}" fill="none" stroke="var(--lime)" stroke-width="2.4" stroke-linejoin="round" />
      </svg>
    `;
  }

  bindRenderedHandlers(dues, pnl) {
    this.container.querySelectorAll('[data-period]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.periodKey = btn.dataset.period;
        this.render();
      });
    });

    document.getElementById('customStartInput')?.addEventListener('change', (e) => {
      this.customStart = e.target.value;
      this.render();
    });
    document.getElementById('customEndInput')?.addEventListener('change', (e) => {
      this.customEnd = e.target.value;
      this.render();
    });

    document.getElementById('defaultCreditDaysInput')?.addEventListener('change', async (e) => {
      const val = Math.max(1, Math.min(365, Number(e.target.value) || 30));
      this.app.state.settings.defaultCreditDays = val;
      await this.app.persistState();
      this.render();
    });

    document.getElementById('openAddSaleModalBtn')?.addEventListener('click', () => this.openSaleModal('sale'));
    document.getElementById('pnlEmptyAddBtn')?.addEventListener('click', () => this.openSaleModal('sale'));

    // Customer khata modal triggers
    this.container.querySelectorAll('[data-open-khata]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.openKhata;
        const cust = dues.customers.find((c) => c.customerName === name);
        if (cust) this.openKhataModal(cust);
      });
    });

    // Polite Remind share sheet triggers
    this.container.querySelectorAll('[data-remind-customer]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.remindCustomer;
        const cust = dues.customers.find((c) => c.customerName === name);
        if (cust) this.shareReminder(cust);
      });
    });

    // P&L interactive hover/tap/focus tooltip
    const tooltip = document.getElementById('pnlTooltip');
    this.container.querySelectorAll('[data-pnl-idx]').forEach((g) => {
      const show = () => {
        const b = pnl.series[Number(g.dataset.pnlIdx)];
        if (!b || !tooltip) return;
        const dateLabel =
          pnl.groupBy === 'month'
            ? formatLocalizedDate(b.key, { month: 'short', year: 'numeric' })
            : formatLocalizedDate(b.key, { day: 'numeric', month: 'short', year: 'numeric' });
        tooltip.innerHTML = `
          <strong>${esc(dateLabel)}</strong>
          <div class="tooltip-grid tabular">
            <span>${esc(t('reports.pnl.revenue'))}: ${esc(formatCurrencyInr(b.revenue))}</span>
            <span>${esc(t('reports.pnl.cogs'))}: ${esc(formatCurrencyInr(b.cogs))}</span>
            <span>${esc(t('reports.pnl.expenses'))}: ${esc(formatCurrencyInr(b.expenses))}</span>
            <span class="${b.profit >= 0 ? 'is-profit' : 'is-loss'}">${esc(b.profit >= 0 ? t('reports.pnl.profit') : t('reports.pnl.loss'))}: ${b.profit >= 0 ? '+' : '-'}${esc(formatCurrencyInr(Math.abs(b.profit)))}</span>
          </div>
        `;
        tooltip.hidden = false;
      };
      g.addEventListener('mouseenter', show);
      g.addEventListener('click', show);
      g.addEventListener('focus', show);
    });

    // Stock add & restock
    document.getElementById('addStockForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('stockNameInput').value.trim();
      const qty = Math.max(0, Number(document.getElementById('stockQtyInput').value || 0));
      const costPrice = Math.max(0, Number(document.getElementById('stockCostInput').value || 0));
      const sellPrice = Math.max(0, Number(document.getElementById('stockSellInput').value || 0));
      if (!name) return;

      this.app.state.stocks = this.app.state.stocks || [];
      this.app.state.stocks.unshift({
        id: `sku-${Date.now()}`,
        name,
        qty,
        reorderAt: 10,
        costPrice,
        sellPrice,
        soldUnits: 0,
      });
      await this.app.persistState();
      this.render();
      this.app.showToast(`Added stock item: ${name}`);
    });

    this.container.querySelectorAll('[data-restock-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.restockId;
        const item = (this.app.state.stocks || []).find((s) => s.id === id);
        if (!item) return;
        item.qty += 5;
        await this.app.persistState();
        this.render();
      });
    });
  }
}
