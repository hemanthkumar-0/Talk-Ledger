import {
  clearSupabaseLedgerData,
  getActiveSession,
  initAuthClient,
  onAuthSessionChange,
  pullStateFromSupabase,
  syncStateToSupabase,
} from '../db.js';
import { addDaysIso, toIsoDay } from '../pnl.js';
import { AudioEngine } from './audio.js';
import { AuthController } from './auth.js';
import {
  formatCurrencyInr,
  getSavedLanguage,
  loadLanguage,
  onLanguageChange,
  t,
} from './i18n.js';
import {
  buildBalanceReply,
  buildDailySummaryReply,
  buildEntriesReply,
  parseUtterance,
  selectEntryToCorrect,
  toLocalIsoDate,
} from './parser.js';
import { ReportsController } from './reports.js';
import { SignalMatrixBackground } from './signal-bg.js';
import { initThemeSystem } from './theme.js';
import {
  initVault,
  loadEncryptedState,
  saveEncryptedState,
  wipeEncryptedVault,
} from './vault.js';
import { VoiceEngine } from './voice.js';

const AI_GREETING = 'Hello, I am an AI assistant for your credit book.';

function createEmptyLedgerState() {
  return {
    entries: [],
    customers: [],
    businessRecords: [],
    stocks: [],
    lastBatchIds: [],
    settings: {
      noiseFilter: true,
      muted: false,
      handsFree: false,
      defaultCreditDays: 30,
    },
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');
}

class VoiceKhataApp {
  constructor() {
    this.state = createEmptyLedgerState();
    this.activeView = 'book';
    this.activeFilter = 'all';
    this.searchQuery = '';
    this.highlightedCustomer = null;
    this.pendingDisambiguation = null;
    this.newlyAddedIds = new Set();
    this.justCorrectedId = null;
    this.spacebarHeld = false;
    this.toastTimer = null;

    this.audio = new AudioEngine();
    this.signalBg = null;
    this.reports = new ReportsController(this);
    this.auth = new AuthController(this);

    this.voice = new VoiceEngine(this.audio, {
      onModeChange: (mode) => this.updateVoiceModeBadge(mode),
      onListeningChange: (listening) => {
        this.updateListeningUI(listening);
        this.signalBg?.setAudioEnergy(listening ? 0.85 : 0);
      },
      onPartialTranscript: (text) => this.setTranscript(text, false),
      onFinalTranscript: (text) => this.handleUtterance(text),
      onError: (msg) => this.showToast(msg),
    });
  }

  async init() {
    initThemeSystem();
    this.cacheDom();

    this.signalBg = new SignalMatrixBackground(document.getElementById('signalAmbientCanvas'));
    this.signalBg.init();

    const savedLang = getSavedLanguage();
    if (this.el.headerLangSelect) this.el.headerLangSelect.value = savedLang;
    await loadLanguage(savedLang);
    onLanguageChange(() => {
      this.renderAll();
      if (this.auth.isOpen) this.auth.render();
    });

    this.bindEvents();
    this.audio.registerCanvas(this.el.mainWaveCanvas);

    // Initialize on-device AES-GCM 256-bit IndexedDB vault
    const vaultInfo = await initVault();
    if (this.el.vaultBadgeLabel) {
      this.el.vaultBadgeLabel.textContent = vaultInfo.encrypted
        ? t('voice.encryptedOnDevice')
        : 'Local vault active';
    }
    if (this.el.vaultAlgoVal) {
      this.el.vaultAlgoVal.textContent = vaultInfo.algorithm;
    }

    const saved = await loadEncryptedState();
    const defaults = createEmptyLedgerState();
    if (saved && Array.isArray(saved.entries)) {
      this.state = {
        ...defaults,
        ...saved,
        businessRecords: Array.isArray(saved.businessRecords) ? saved.businessRecords : [],
        stocks: Array.isArray(saved.stocks) ? saved.stocks : [],
        settings: {
          ...defaults.settings,
          ...(saved.settings || {}),
        },
      };
    }

    this.audio.setNoiseFilter(this.state.settings.noiseFilter);
    this.voice.handsFree = Boolean(this.state.settings.handsFree);
    this.syncToggleButtons();
    this.syncAccountHeader();

    onAuthSessionChange((session) => {
      this.syncAccountHeader();
      if (session?.provider === 'supabase') {
        this.hydrateFromSupabase().catch(() => undefined);
      }
    });
    initAuthClient()
      .then(() => {
        this.syncAccountHeader();
        if (getActiveSession()?.provider === 'supabase') {
          return this.hydrateFromSupabase();
        }
        return undefined;
      })
      .catch(() => undefined);

    await this.voice.detectBackendMode();
    this.reports.init();
    this.renderAll();
    this.registerServiceWorker();

    if (window.location.hash === '#auth') {
      this.auth.open('login');
    }
  }

  cacheDom() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      headerLangSelect: $('headerLangSelect'),
      openAuthBtn: $('openAuthBtn'),
      railAuthBtn: $('railAuthBtn'),
      railAccountLabel: $('railAccountLabel'),
      voiceModeBadge: $('voiceModeBadge'),
      voiceModeText: $('voiceModeText'),
      muteToggleBtn: $('muteToggleBtn'),
      muteIcon: $('muteIcon'),
      mainWaveCanvas: $('mainWaveCanvas'),
      voiceConsoleCard: $('voiceConsoleCard'),
      voiceStateText: $('voiceStateText'),
      noiseFilterBtn: $('noiseFilterBtn'),
      handsFreeBtn: $('handsFreeBtn'),
      mobileHandsFreeBtn: $('mobileHandsFreeBtn'),
      liveTranscriptText: $('liveTranscriptText'),
      replyTag: $('replyTag'),
      replyText: $('replyText'),
      disambiguationCard: $('disambiguationCard'),
      disambiguationPrompt: $('disambiguationPrompt'),
      disambiguationChoices: $('disambiguationChoices'),
      holdTalkBtn: $('holdTalkBtn'),
      holdTalkLabel: $('holdTalkLabel'),
      mobileHoldTalkBtn: $('mobileHoldTalkBtn'),
      mobileHoldLabel: $('mobileHoldLabel'),
      mobileFocusTypeBtn: $('mobileFocusTypeBtn'),
      simVoiceForm: $('simVoiceForm'),
      simVoiceInput: $('simVoiceInput'),
      ledgerSearchInput: $('ledgerSearchInput'),
      ledgerFeedList: $('ledgerFeedList'),
      todayTotalQueryBtn: $('todayTotalQueryBtn'),
      customersDetailList: $('customersDetailList'),
      sideBalancesList: $('sideBalancesList'),
      viewAllCustomersBtn: $('viewAllCustomersBtn'),
      navEntryCount: $('navEntryCount'),
      navCustomerCount: $('navCustomerCount'),
      kpiCreditGiven: $('kpiCreditGiven'),
      kpiReceived: $('kpiReceived'),
      kpiCreditBar: $('kpiCreditBar'),
      kpiPaidBar: $('kpiPaidBar'),
      kpiNetVal: $('kpiNetVal'),
      kpiDateLabel: $('kpiDateLabel'),
      mobileCreditVal: $('mobileCreditVal'),
      mobilePaidVal: $('mobilePaidVal'),
      vaultBadgeLabel: $('vaultBadgeLabel'),
      vaultAlgoVal: $('vaultAlgoVal'),
      openWipeModalBtn: $('openWipeModalBtn'),
      wipeModalBackdrop: $('wipeModalBackdrop'),
      cancelWipeBtn: $('cancelWipeBtn'),
      confirmWipeBtn: $('confirmWipeBtn'),
      toastPill: $('toastPill'),
      panels: {
        book: $('panelBook'),
        reports: $('panelReports'),
        customers: $('panelCustomers'),
        vault: $('panelVault'),
      },
    };
  }

  bindEvents() {
    this.el.headerLangSelect?.addEventListener('change', async (e) => {
      await loadLanguage(e.target.value);
      this.showToast(`Language: ${e.target.options[e.target.selectedIndex].text}`);
    });

    const openAuth = () => this.auth.open('login');
    this.el.openAuthBtn?.addEventListener('click', openAuth);
    this.el.railAuthBtn?.addEventListener('click', openAuth);

    document.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.view));
    });

    this.el.muteToggleBtn?.addEventListener('click', () => {
      this.state.settings.muted = !this.state.settings.muted;
      if (this.state.settings.muted) this.voice.cancelSpeech();
      this.syncToggleButtons();
      this.persistState();
      this.showToast(this.state.settings.muted ? 'Spoken read-back muted' : 'Spoken read-back enabled');
    });

    this.el.noiseFilterBtn?.addEventListener('click', () => {
      this.state.settings.noiseFilter = !this.state.settings.noiseFilter;
      this.audio.setNoiseFilter(this.state.settings.noiseFilter);
      this.syncToggleButtons();
      this.persistState();
    });

    const toggleHandsFree = () => {
      this.state.settings.handsFree = !this.state.settings.handsFree;
      this.voice.handsFree = this.state.settings.handsFree;
      this.syncToggleButtons();
      this.persistState();
    };
    this.el.handsFreeBtn?.addEventListener('click', toggleHandsFree);
    this.el.mobileHandsFreeBtn?.addEventListener('click', toggleHandsFree);

    this.bindMicButton(this.el.holdTalkBtn);
    this.bindMicButton(this.el.mobileHoldTalkBtn);

    this.el.mobileFocusTypeBtn?.addEventListener('click', () => {
      this.el.simVoiceInput?.focus();
      this.el.simVoiceInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeWipeModal();
        this.reports.closeKhataModal();
        this.reports.closeSaleModal();
        return;
      }

      if (e.code === 'Space' && !e.repeat && !this.auth.isOpen) {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
        e.preventDefault();
        this.spacebarHeld = true;
        this.voice.startListening();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && this.spacebarHeld) {
        e.preventDefault();
        this.spacebarHeld = false;
        this.voice.stopListening();
      }
    });

    this.el.simVoiceForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.el.simVoiceInput.value.trim();
      if (!text) return;
      this.el.simVoiceInput.value = '';
      this.audio.pulseSimulation(850);
      this.handleUtterance(text);
    });

    this.el.todayTotalQueryBtn?.addEventListener('click', () => {
      this.audio.pulseSimulation(800);
      this.handleUtterance("Today's total");
    });

    this.el.ledgerSearchInput?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.trim().toLowerCase();
      this.renderLedgerFeed();
    });

    document.querySelectorAll('[data-filter]').forEach((pill) => {
      pill.addEventListener('click', () => {
        this.activeFilter = pill.dataset.filter;
        document.querySelectorAll('[data-filter]').forEach((p) => p.classList.toggle('is-active', p === pill));
        this.renderLedgerFeed();
      });
    });

    this.el.viewAllCustomersBtn?.addEventListener('click', () => this.switchView('customers'));

    this.el.openWipeModalBtn?.addEventListener('click', () => this.openWipeModal());
    this.el.cancelWipeBtn?.addEventListener('click', () => this.closeWipeModal());
    this.el.wipeModalBackdrop?.addEventListener('click', (e) => {
      if (e.target === this.el.wipeModalBackdrop) this.closeWipeModal();
    });
    this.el.confirmWipeBtn?.addEventListener('click', async () => this.wipeAllData());
  }

  bindMicButton(btn) {
    if (!btn) return;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.state.settings.handsFree) {
        if (this.voice.listening) this.voice.stopListening();
        else this.voice.startListening();
        return;
      }
      this.voice.startListening();
    });

    const release = () => {
      if (!this.state.settings.handsFree && this.voice.listening) {
        this.voice.stopListening();
      }
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', (e) => {
      if (e.buttons === 1) release();
    });
  }

  syncAccountHeader() {
    const session = getActiveSession();
    if (this.el.railAccountLabel) {
      this.el.railAccountLabel.textContent = session ? session.name : t('nav.auth');
    }
  }

  switchView(viewName) {
    if (!this.el.panels[viewName]) return;
    this.activeView = viewName;

    Object.entries(this.el.panels).forEach(([key, panel]) => {
      panel.hidden = key !== viewName;
    });

    document.querySelectorAll('[data-view]').forEach((btn) => {
      const active = btn.dataset.view === viewName;
      btn.classList.toggle('is-active', active);
      if (btn.getAttribute('role') === 'tab') {
        btn.setAttribute('aria-selected', String(active));
      }
    });

    if (viewName === 'reports') this.reports.render();
  }

  openWipeModal() {
    this.el.wipeModalBackdrop.hidden = false;
    this.el.cancelWipeBtn?.focus();
  }

  closeWipeModal() {
    this.el.wipeModalBackdrop.hidden = true;
  }

  syncToggleButtons() {
    const { noiseFilter, handsFree, muted } = this.state.settings;

    this.el.noiseFilterBtn?.classList.toggle('is-on', noiseFilter);
    this.el.noiseFilterBtn?.setAttribute('aria-pressed', String(noiseFilter));

    this.el.handsFreeBtn?.classList.toggle('is-on', handsFree);
    this.el.handsFreeBtn?.setAttribute('aria-pressed', String(handsFree));

    this.el.mobileHandsFreeBtn?.classList.toggle('is-on', handsFree);
    this.el.mobileHandsFreeBtn?.setAttribute('aria-pressed', String(handsFree));

    if (this.el.holdTalkLabel && !this.voice.listening) {
      this.el.holdTalkLabel.textContent = handsFree ? t('voice.tapToSpeak') : t('voice.holdToTalk');
    }
    if (this.el.mobileHoldLabel && !this.voice.listening) {
      this.el.mobileHoldLabel.textContent = handsFree ? t('voice.tapToSpeak') : t('voice.holdToTalk');
    }

    if (this.el.muteIcon) {
      this.el.muteIcon.innerHTML = muted
        ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>'
        : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>';
    }
  }

  updateVoiceModeBadge(mode) {
    const isGnani = mode === 'gnani';
    this.el.voiceModeBadge?.classList.toggle('is-gnani', isGnani);
    if (this.el.voiceModeText) {
      this.el.voiceModeText.textContent = isGnani ? t('voice.gnaniLive') : t('voice.browserMode');
    }
  }

  updateListeningUI(listening) {
    this.el.voiceConsoleCard?.classList.toggle('is-listening', listening);
    this.el.holdTalkBtn?.classList.toggle('is-active', listening);
    this.el.mobileHoldTalkBtn?.classList.toggle('is-active', listening);

    if (this.el.voiceStateText) {
      this.el.voiceStateText.textContent = listening ? t('voice.listening') : t('voice.ready');
    }
  }

  setTranscript(text, isPlaceholder = false) {
    if (!this.el.liveTranscriptText) return;
    this.el.liveTranscriptText.textContent = text;
    this.el.liveTranscriptText.classList.toggle('is-placeholder', isPlaceholder);
  }

  setReply(tag, text) {
    if (this.el.replyTag) this.el.replyTag.textContent = tag;
    if (this.el.replyText) this.el.replyText.textContent = text;
  }

  ensureCustomerExists(name) {
    const existing = this.state.customers.find(
      (c) => c.name.toLowerCase() === name.toLowerCase()
    );
    if (!existing) {
      this.state.customers.push({ name, optInReminder: false });
    }
  }

  async addManualDebitEntry({ customerName, amount, dateIso, dueDate, note }) {
    this.ensureCustomerExists(customerName);
    const defaultDays = Number(this.state.settings.defaultCreditDays ?? 30);
    const effectiveDue = dueDate || addDaysIso(dateIso, defaultDays);
    const id = `entry-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.state.entries.push({
      id,
      customerName,
      amount,
      type: 'credit',
      accountingType: 'debit',
      dateIso,
      dueDate: effectiveDue,
      dateLabel: dateIso === toIsoDay(new Date()) ? 'today' : dateIso,
      dateOffset: 0,
      createdAt: new Date().toISOString(),
      sourceClause: note || `${customerName}, ${amount} Debit (Dr)`,
    });
    await this.persistState();
    this.renderAll();
    this.showToast(`Recorded Debit (Dr) ${formatCurrencyInr(amount)} for ${customerName}`);
  }

  async addBusinessRecord(record) {
    this.state.businessRecords = this.state.businessRecords || [];
    this.state.businessRecords.push(record);
    await this.persistState();
    this.renderAll();
    this.showToast(`Saved ${record.kind}: ${formatCurrencyInr(record.amount)}`);
  }

  computeCustomerBalances() {
    const map = new Map();
    for (const c of this.state.customers) {
      map.set(c.name.toLowerCase(), {
        name: c.name,
        credit: 0,
        paid: 0,
        net: 0,
        count: 0,
        optInReminder: Boolean(c.optInReminder),
      });
    }

    for (const e of this.state.entries) {
      const key = e.customerName.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          name: e.customerName,
          credit: 0,
          paid: 0,
          net: 0,
          count: 0,
          optInReminder: false,
        });
      }
      const rec = map.get(key);
      if (e.type === 'credit') rec.credit += e.amount;
      else rec.paid += e.amount;
      rec.net = rec.credit - rec.paid;
      rec.count += 1;
    }

    return Array.from(map.values()).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  }

  computeTotals(onlyToday = false) {
    const todayIso = toLocalIsoDate(new Date());
    let credit = 0;
    let paid = 0;

    for (const e of this.state.entries) {
      if (onlyToday && e.dateIso !== todayIso) continue;
      if (e.type === 'credit') credit += e.amount;
      else paid += e.amount;
    }

    return { credit, paid, net: credit - paid };
  }

  async handleUtterance(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return;

    this.setTranscript(`"${text}"`, false);

    const parsed = parseUtterance(text, {
      customers: this.state.customers,
      entries: this.state.entries,
      pendingDisambiguation: this.pendingDisambiguation,
      referenceDate: new Date(),
    });

    let replyText = parsed.reply || '';
    let replyTag = 'Voice Confirmation';

    if (parsed.intent === 'disambiguation_required') {
      this.pendingDisambiguation = parsed;
      replyTag = 'Confirm Customer';
      replyText = parsed.reply;
      this.renderDisambiguationCard();
    } else if (parsed.intent === 'disambiguation_cancel') {
      this.pendingDisambiguation = null;
      this.renderDisambiguationCard();
      replyTag = 'Cancelled';
    } else if (parsed.intent === 'disambiguation_resolved') {
      const selected = parsed.selectedCustomer;
      const pending = parsed.pending;
      this.pendingDisambiguation = null;
      this.renderDisambiguationCard();

      if (pending.forIntent === 'ledger_entries') {
        const resolvedEntries = (pending.pendingEntries || []).map((item) => ({
          ...item,
          customerName: selected,
        }));
        await this.commitParsedEntries(resolvedEntries);
        replyTag = 'Saved';
        replyText = buildEntriesReply(resolvedEntries);
      } else if (pending.forIntent === 'balance_query') {
        replyTag = 'Customer Balance';
        replyText = this.resolveBalanceQuery(selected);
      }
    } else if (parsed.intent === 'ledger_entries') {
      this.pendingDisambiguation = null;
      this.renderDisambiguationCard();
      await this.commitParsedEntries(parsed.entries);
      replyTag = `Saved (${parsed.entries.length} ${parsed.entries.length === 1 ? 'entry' : 'entries'})`;
      replyText = parsed.reply;
    } else if (parsed.intent === 'correction') {
      const target = selectEntryToCorrect(this.state.entries, parsed, this.state.lastBatchIds);
      if (!target) {
        replyTag = 'Nothing to Correct';
        replyText = 'There are no entries yet to correct.';
      } else {
        const previousAmount = target.amount;
        if (!Array.isArray(target.correctionHistory)) target.correctionHistory = [];
        target.correctionHistory.push({ from: previousAmount, to: parsed.amount, at: new Date().toISOString() });
        target.originalAmount = target.originalAmount ?? previousAmount;
        target.previousAmount = previousAmount;
        target.amount = parsed.amount;
        if (parsed.type) target.type = parsed.type;
        target.correctedAt = new Date().toISOString();

        this.justCorrectedId = target.id;
        this.highlightedCustomer = target.customerName;
        await this.persistState();

        replyTag = 'Corrected';
        replyText = `${target.customerName}, ${target.amount} ${target.type}. Corrected.`;
      }
    } else if (parsed.intent === 'balance_query') {
      replyTag = 'Customer Balance';
      replyText = this.resolveBalanceQuery(parsed.customerName);
    } else if (parsed.intent === 'daily_summary_query') {
      const todayTotals = this.computeTotals(true);
      const allTotals = this.computeTotals(false);
      const useTotals = todayTotals.credit + todayTotals.paid > 0 ? todayTotals : allTotals;
      replyTag = "Today's Summary";
      replyText = buildDailySummaryReply(useTotals.credit, useTotals.paid);
    } else if (parsed.intent === 'greeting') {
      replyTag = 'Voice Assistant';
      replyText = AI_GREETING;
    } else {
      replyTag = 'Notice';
    }

    this.setReply(replyTag, replyText);
    this.renderAll();
    await this.voice.speak(replyText, { muted: this.state.settings.muted });
  }

  async commitParsedEntries(parsedEntries) {
    const batchIds = [];
    this.newlyAddedIds.clear();
    this.justCorrectedId = null;
    const defaultCreditDays = Number(this.state.settings.defaultCreditDays ?? 30);

    for (const item of parsedEntries) {
      this.ensureCustomerExists(item.customerName);
      const id = `entry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      this.state.entries.push({
        id,
        customerName: item.customerName,
        amount: item.amount,
        type: item.type,
        dateIso: item.dateIso,
        dueDate: item.type === 'credit' ? addDaysIso(item.dateIso, defaultCreditDays) : null,
        dateLabel: item.dateLabel,
        dateOffset: item.dateOffset,
        createdAt: new Date().toISOString(),
        sourceClause: item.sourceClause,
      });
      batchIds.push(id);
      this.newlyAddedIds.add(id);
      this.highlightedCustomer = item.customerName;
    }

    this.state.lastBatchIds = batchIds;
    await this.persistState();
  }

  resolveBalanceQuery(customerName) {
    const balances = this.computeCustomerBalances();
    const match = balances.find((b) => b.name.toLowerCase() === customerName.toLowerCase());
    this.highlightedCustomer = match ? match.name : customerName;
    const net = match ? match.net : 0;
    return buildBalanceReply(this.highlightedCustomer, net);
  }

  async wipeAllData() {
    this.closeWipeModal();
    await wipeEncryptedVault();
    await clearSupabaseLedgerData();
    await initVault();
    this.state = {
      ...createEmptyLedgerState(),
      settings: { ...this.state.settings },
    };
    this.pendingDisambiguation = null;
    this.highlightedCustomer = null;
    this.renderAll();
    this.setTranscript('No entries yet. Tap the mic and speak.', true);
    this.setReply('Vault Cleared', 'All local ledger data and encryption keys have been permanently deleted.');
    this.showToast('Local encrypted vault permanently deleted');
  }

  async hydrateFromSupabase() {
    if (this._hydratingCloud) return;
    this._hydratingCloud = true;
    try {
      const cloud = await pullStateFromSupabase();
      if (!cloud) return;

      const custMap = new Map();
      for (const c of cloud.customers) custMap.set(c.name.toLowerCase(), { ...c });
      for (const c of this.state.customers) {
        const k = c.name.toLowerCase();
        if (!custMap.has(k)) custMap.set(k, { ...c });
      }

      const mergeById = (remoteList, localList) => {
        const byId = new Map();
        for (const item of remoteList) byId.set(item.id, item);
        for (const item of localList) {
          if (!byId.has(item.id)) byId.set(item.id, item);
        }
        return Array.from(byId.values());
      };

      this.state.customers = Array.from(custMap.values());
      this.state.entries = mergeById(cloud.entries, this.state.entries).sort((a, b) =>
        String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      );
      this.state.businessRecords = mergeById(cloud.businessRecords, this.state.businessRecords || []);
      this.state.stocks = mergeById(cloud.stocks, this.state.stocks || []);
      if (cloud.defaultCreditDays) {
        this.state.settings.defaultCreditDays = cloud.defaultCreditDays;
      }

      await saveEncryptedState(this.state);
      await syncStateToSupabase(this.state);
      this.renderAll();
    } finally {
      this._hydratingCloud = false;
    }
  }

  async persistState() {
    const localResult = await saveEncryptedState(this.state);
    if (getActiveSession()?.provider === 'supabase') {
      syncStateToSupabase(this.state).catch(() => undefined);
    }
    return localResult;
  }

  showToast(message) {
    if (!this.el.toastPill) return;
    this.el.toastPill.textContent = message;
    this.el.toastPill.classList.add('is-visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.el.toastPill.classList.remove('is-visible');
    }, 3000);
  }

  renderAll() {
    this.renderKPIs();
    this.renderLedgerFeed();
    this.renderCustomerBalances();
    this.renderDisambiguationCard();
    if (this.activeView === 'reports') {
      this.reports.render();
    }
  }

  renderKPIs() {
    const totals = this.computeTotals(false);
    const totalFlow = Math.max(1, totals.credit + totals.paid);
    const creditPct = totals.credit + totals.paid === 0 ? 50 : Math.round((totals.credit / totalFlow) * 100);
    const paidPct = 100 - creditPct;

    if (this.el.kpiCreditGiven) this.el.kpiCreditGiven.textContent = formatCurrencyInr(totals.credit);
    if (this.el.kpiReceived) this.el.kpiReceived.textContent = formatCurrencyInr(totals.paid);
    if (this.el.mobileCreditVal) this.el.mobileCreditVal.textContent = formatCurrencyInr(totals.credit);
    if (this.el.mobilePaidVal) this.el.mobilePaidVal.textContent = formatCurrencyInr(totals.paid);

    const netPrefix = totals.net > 0 ? '+' : totals.net < 0 ? '-' : '';
    const netDisplay = `${netPrefix}${formatCurrencyInr(totals.net)}`;
    if (this.el.kpiNetVal) this.el.kpiNetVal.textContent = netDisplay;

    if (this.el.kpiCreditBar) this.el.kpiCreditBar.style.width = `${creditPct}%`;
    if (this.el.kpiPaidBar) this.el.kpiPaidBar.style.width = `${paidPct}%`;

    if (this.el.kpiDateLabel) {
      this.el.kpiDateLabel.textContent = new Date().toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
      });
    }

    if (this.el.navEntryCount) this.el.navEntryCount.textContent = String(this.state.entries.length);
    if (this.el.navCustomerCount) {
      this.el.navCustomerCount.textContent = String(this.computeCustomerBalances().length);
    }
  }

  renderDisambiguationCard() {
    const card = this.el.disambiguationCard;
    if (!card) return;
    if (!this.pendingDisambiguation) {
      card.hidden = true;
      return;
    }

    card.hidden = false;
    this.el.disambiguationPrompt.textContent = this.pendingDisambiguation.reply;

    const choicesHtml = (this.pendingDisambiguation.candidates || [])
      .map(
        (name) =>
          `<button type="button" class="disambig-choice-btn" data-disambig="${escapeHtml(name)}">${escapeHtml(name)}</button>`
      )
      .join('');

    this.el.disambiguationChoices.innerHTML = `${choicesHtml}<button type="button" class="disambig-cancel-btn" data-disambig="__cancel__">Cancel</button>`;

    this.el.disambiguationChoices.querySelectorAll('[data-disambig]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.disambig;
        this.handleUtterance(val === '__cancel__' ? 'cancel' : val);
      });
    });
  }

  renderLedgerFeed() {
    const list = this.el.ledgerFeedList;
    if (!list) return;

    const todayIso = toLocalIsoDate(new Date());
    const filtered = [...this.state.entries]
      .reverse()
      .filter((e) => {
        if (this.activeFilter === 'credit' && e.type !== 'credit') return false;
        if (this.activeFilter === 'paid' && e.type !== 'paid') return false;
        if (this.activeFilter === 'today' && e.dateIso !== todayIso) return false;
        if (this.searchQuery) {
          const hay = `${e.customerName} ${e.sourceClause || ''} ${e.dateLabel || ''}`.toLowerCase();
          if (!hay.includes(this.searchQuery)) return false;
        }
        return true;
      });

    if (filtered.length === 0) {
      const hasAnyEntries = this.state.entries.length > 0;
      list.innerHTML = `
        <li class="empty-state">
          <div class="empty-state-icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              <line x1="12" y1="19" x2="12" y2="22"></line>
            </svg>
          </div>
          <h3>${hasAnyEntries ? 'No matching entries' : 'No entries yet. Tap the mic and speak.'}</h3>
          <p>${
            hasAnyEntries
              ? 'Try clearing your search filter to see all recorded khata entries.'
              : 'Say a customer name and amount—such as "Ramesh, 340 on credit" or "Sunita paid 200 today".'
          }</p>
        </li>
      `;
      return;
    }

    list.innerHTML = filtered
      .map((entry) => {
        const isCredit = entry.type === 'credit';
        const sign = isCredit ? '+' : '-';
        const isNew = this.newlyAddedIds.has(entry.id);
        const isJustCorrected = this.justCorrectedId === entry.id;
        const hasCorrection = Boolean(entry.originalAmount && entry.originalAmount !== entry.amount);

        const oldFigureHtml = hasCorrection
          ? `<span class="amount-old tabular">${sign}${formatCurrencyInr(entry.originalAmount)}</span>`
          : '';
        const correctedBadge = hasCorrection ? `<span class="corrected-tag">Corrected</span>` : '';

        const rowClasses = ['ledger-row', isNew ? 'is-new' : '', isJustCorrected ? 'is-corrected-pulse' : '']
          .filter(Boolean)
          .join(' ');

        return `
          <li class="${rowClasses}" data-entry-id="${escapeHtml(entry.id)}">
            <div class="ledger-row-left">
              <div class="customer-avatar ${isCredit ? 'customer-avatar--credit' : 'customer-avatar--paid'}" aria-hidden="true">
                ${escapeHtml(initials(entry.customerName))}
              </div>
              <div class="ledger-row-info">
                <div class="ledger-customer-name">
                  <span>${escapeHtml(entry.customerName)}</span>
                  ${correctedBadge}
                </div>
                <div class="ledger-meta">
                  <span>${escapeHtml(entry.dateLabel)}</span>
                  <span>&middot;</span>
                  <span class="tabular">${escapeHtml(entry.dateIso)}</span>
                  ${entry.sourceClause ? `<span>&middot; &ldquo;${escapeHtml(entry.sourceClause)}&rdquo;</span>` : ''}
                </div>
              </div>
            </div>
            <div class="ledger-row-right">
              <div class="amount-display ${isCredit ? 'amount-credit' : 'amount-paid'} tabular">
                ${oldFigureHtml}
                <span>${sign} ${formatCurrencyInr(entry.amount)}</span>
              </div>
              <span class="amount-type-sub">${isCredit ? 'credit' : 'paid'}, ${escapeHtml(entry.dateLabel)}</span>
            </div>
          </li>
        `;
      })
      .join('');
  }

  renderCustomerBalances() {
    const balances = this.computeCustomerBalances();

    if (this.el.sideBalancesList) {
      if (balances.length === 0) {
        this.el.sideBalancesList.innerHTML = `<li class="balance-item"><span class="balance-item-sub">No customers yet. Speak your first entry.</span></li>`;
      } else {
        this.el.sideBalancesList.innerHTML = balances
          .map((c) => {
            const highlighted =
              this.highlightedCustomer && c.name.toLowerCase() === this.highlightedCustomer.toLowerCase();
            const pillClass =
              c.net > 0 ? 'balance-pill--owes' : c.net === 0 ? 'balance-pill--settled' : 'balance-pill--advance';
            const pillLabel =
              c.net > 0
                ? `Owes ${formatCurrencyInr(c.net)}`
                : c.net === 0
                ? 'Settled'
                : `Adv ${formatCurrencyInr(c.net)}`;

            return `
              <li class="balance-item ${highlighted ? 'is-highlighted' : ''}" data-customer-filter="${escapeHtml(c.name)}">
                <div>
                  <div class="balance-item-name">${escapeHtml(c.name)}</div>
                  <div class="balance-item-sub tabular">${c.count} ${c.count === 1 ? 'entry' : 'entries'}${c.optInReminder ? ' · Reminder opt-in' : ''}</div>
                </div>
                <span class="balance-pill ${pillClass} tabular">${pillLabel}</span>
              </li>
            `;
          })
          .join('');

        this.el.sideBalancesList.querySelectorAll('[data-customer-filter]').forEach((item) => {
          item.addEventListener('click', () => {
            const name = item.dataset.customerFilter;
            this.highlightedCustomer = name;
            this.searchQuery = name.toLowerCase();
            if (this.el.ledgerSearchInput) this.el.ledgerSearchInput.value = name;
            this.switchView('book');
            this.renderAll();
          });
        });
      }
    }

    if (this.el.customersDetailList) {
      if (balances.length === 0) {
        this.el.customersDetailList.innerHTML = `<div class="empty-state"><h3>No customers yet</h3><p>Tap the mic and speak a customer name and amount to create their khata automatically.</p></div>`;
      } else {
        this.el.customersDetailList.innerHTML = balances
          .map((c) => {
            const highlighted =
              this.highlightedCustomer && c.name.toLowerCase() === this.highlightedCustomer.toLowerCase();
            const pillClass =
              c.net > 0 ? 'balance-pill--owes' : c.net === 0 ? 'balance-pill--settled' : 'balance-pill--advance';
            const pillLabel =
              c.net > 0
                ? `Owes ${formatCurrencyInr(c.net)}`
                : c.net === 0
                ? 'Settled'
                : `Advance ${formatCurrencyInr(c.net)}`;

            return `
              <div class="customer-detail-row ${highlighted ? 'is-highlighted' : ''}">
                <div>
                  <div class="ledger-customer-name">${escapeHtml(c.name)}</div>
                  <div class="ledger-meta tabular">Dr ${formatCurrencyInr(c.credit)} &middot; Cr ${formatCurrencyInr(c.paid)} &middot; ${c.count} ${c.count === 1 ? 'entry' : 'entries'}</div>
                </div>
                <div class="customer-controls">
                  <span class="balance-pill ${pillClass} tabular">${pillLabel}</span>
                  <label class="optin-label">
                    <input type="checkbox" class="sr-only optin-checkbox" data-optin-customer="${escapeHtml(c.name)}" ${c.optInReminder ? 'checked' : ''} />
                    <span class="switch-track" aria-hidden="true"></span>
                    <span>Opt-in reminder</span>
                  </label>
                  <button type="button" class="btn-secondary" data-ask-balance="${escapeHtml(c.name)}">Ask Total</button>
                </div>
              </div>
            `;
          })
          .join('');

        this.el.customersDetailList.querySelectorAll('[data-optin-customer]').forEach((box) => {
          box.addEventListener('change', async () => {
            const name = box.dataset.optinCustomer;
            this.ensureCustomerExists(name);
            const rec = this.state.customers.find((c) => c.name.toLowerCase() === name.toLowerCase());
            if (rec) rec.optInReminder = box.checked;
            await this.persistState();
            this.renderCustomerBalances();
          });
        });

        this.el.customersDetailList.querySelectorAll('[data-ask-balance]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const name = btn.dataset.askBalance;
            this.audio.pulseSimulation(800);
            this.handleUtterance(`What is ${name}'s total?`);
          });
        });
      }
    }
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new VoiceKhataApp();
  app.init();
});
