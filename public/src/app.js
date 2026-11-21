import {
  clearSupabaseLedgerData,
  getActiveSession,
  initAuthClient,
  onAuthSessionChange,
  pullStateFromSupabase,
  syncStateToSupabase,
} from '../db.js';
import { addDaysIso, toIsoDay } from '../pnl.js';
import { MIN_PRESS_MS, POST_RELEASE_TAIL_MS } from './audio-utils.js';
import { AudioEngine } from './audio.js';
import { AuthController } from './auth.js';
import { VoiceDebugLog } from './debug-log.js';
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
  pickBestTranscriptAlternative,
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
import { resolveSpeechLocale, VoiceEngine } from './voice.js';

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
    this.customerFilter = 'all';
    this.customerSearchQuery = '';
    this.sideFavOnly = false;
    this.lastRawTranscript = '';
    this.highlightedCustomer = null;
    this.pendingDisambiguation = null;
    this.pendingConfirmation = null;
    this.newlyAddedIds = new Set();
    this.justCorrectedId = null;
    this.spacebarHeld = false;
    this.spacebarPressTs = 0;
    this.toastTimer = null;

    this.debugLog = new VoiceDebugLog();
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
      onStatusChange: (status, detail) => {
        if (this.el.voiceStateText && detail) {
          this.el.voiceStateText.textContent = detail;
        }
      },
      onVolumeChange: ({ level, lowVolume }) => {
        this.updateVolumeMeter(level, lowVolume);
      },
      onPartialTranscript: (text, info) => {
        this.lastRawTranscript = text;
        const suffix = info?.isFinalSegment ? '' : ' …';
        this.setTranscript(`${text}${suffix}`, false);
      },
      onFinalTranscript: (text, meta) => this.handleUtterance(text, meta),
      onNotice: (msg) => this.showToast(msg),
      onError: (msg) => {
        this.showToast(msg);
        this.setReply('Voice Notice', msg);
      },
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
    const savedVoiceLang = this.state.settings.voiceLang || resolveSpeechLocale(savedLang);
    this.voice.setLanguage(savedVoiceLang);
    if (this.el.voiceLangSelect) this.el.voiceLangSelect.value = savedVoiceLang;
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
      voiceVolumeFill: $('voiceVolumeFill'),
      lowVolumeWarning: $('lowVolumeWarning'),
      voiceConsoleCard: $('voiceConsoleCard'),
      voiceStateText: $('voiceStateText'),
      voiceLangSelect: $('voiceLangSelect'),
      noiseFilterBtn: $('noiseFilterBtn'),
      handsFreeBtn: $('handsFreeBtn'),
      mobileHandsFreeBtn: $('mobileHandsFreeBtn'),
      liveTranscriptText: $('liveTranscriptText'),
      editLastTranscriptBtn: $('editLastTranscriptBtn'),
      replyTag: $('replyTag'),
      replyText: $('replyText'),
      disambiguationCard: $('disambiguationCard'),
      disambiguationPrompt: $('disambiguationPrompt'),
      disambiguationChoices: $('disambiguationChoices'),
      confirmEntryCard: $('confirmEntryCard'),
      confirmCardTitle: $('confirmCardTitle'),
      confirmConfidenceBadge: $('confirmConfidenceBadge'),
      confirmWarningBox: $('confirmWarningBox'),
      confirmEntriesList: $('confirmEntriesList'),
      confirmCustomerDatalist: $('confirmCustomerDatalist'),
      confirmSaveBtn: $('confirmSaveBtn'),
      confirmEditBtn: $('confirmEditBtn'),
      confirmReadBackBtn: $('confirmReadBackBtn'),
      confirmCancelBtn: $('confirmCancelBtn'),
      voiceDebugDrawer: $('voiceDebugDrawer'),
      voiceDebugCount: $('voiceDebugCount'),
      voiceDebugList: $('voiceDebugList'),
      voiceDebugClearBtn: $('voiceDebugClearBtn'),
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
      customerSearchInput: $('customerSearchInput'),
      customersDetailList: $('customersDetailList'),
      sideBalancesList: $('sideBalancesList'),
      sideFavFilterBtn: $('sideFavFilterBtn'),
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
      const nextUiLang = e.target.value;
      await loadLanguage(nextUiLang);
      const mappedSpeech = resolveSpeechLocale(nextUiLang);
      this.voice.setLanguage(mappedSpeech);
      this.state.settings.voiceLang = mappedSpeech;
      if (this.el.voiceLangSelect) this.el.voiceLangSelect.value = mappedSpeech;
      this.persistState();
      this.showToast(`Language: ${e.target.options[e.target.selectedIndex].text}`);
    });

    this.el.voiceLangSelect?.addEventListener('change', (e) => {
      const nextVoiceLang = e.target.value;
      this.voice.setLanguage(nextVoiceLang);
      this.state.settings.voiceLang = nextVoiceLang;
      this.persistState();
      this.showToast(`Voice recognition set to ${e.target.options[e.target.selectedIndex].text}`);
    });

    this.el.editLastTranscriptBtn?.addEventListener('click', () => {
      if (!this.lastRawTranscript || !this.el.simVoiceInput) return;
      this.el.simVoiceInput.value = this.lastRawTranscript;
      this.el.simVoiceInput.focus();
      this.el.simVoiceInput.select();
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

    this.el.confirmSaveBtn?.addEventListener('click', () => this.confirmPendingEntries());
    this.el.confirmEditBtn?.addEventListener('click', () => this.toggleConfirmationEdit());
    this.el.confirmReadBackBtn?.addEventListener('click', () => this.readBackPendingConfirmation());
    this.el.confirmCancelBtn?.addEventListener('click', () => this.cancelPendingConfirmation());

    if (this.debugLog.enabled && this.el.voiceDebugDrawer) {
      this.el.voiceDebugDrawer.hidden = false;
      this.el.voiceDebugClearBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.debugLog.clear();
        this.renderDebugLog();
      });
      this.renderDebugLog();
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.cancelPendingConfirmation();
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
        this.spacebarPressTs = performance.now();
        this.voice.startListening();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && this.spacebarHeld) {
        e.preventDefault();
        this.spacebarHeld = false;
        const heldMs = performance.now() - this.spacebarPressTs;
        if (heldMs < MIN_PRESS_MS) {
          this.voice.discardListening('Press was too short — hold Spacebar while speaking.');
        } else {
          this.voice.stopListening({ graceMs: POST_RELEASE_TAIL_MS });
        }
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

    this.el.customerSearchInput?.addEventListener('input', (e) => {
      this.customerSearchQuery = e.target.value.trim().toLowerCase();
      this.renderCustomerBalances();
    });

    document.querySelectorAll('[data-customer-filter-tab]').forEach((pill) => {
      pill.addEventListener('click', () => {
        this.customerFilter = pill.dataset.customerFilterTab;
        document
          .querySelectorAll('[data-customer-filter-tab]')
          .forEach((p) => p.classList.toggle('is-active', p === pill));
        this.renderCustomerBalances();
      });
    });

    this.el.sideFavFilterBtn?.addEventListener('click', () => {
      this.sideFavOnly = !this.sideFavOnly;
      this.el.sideFavFilterBtn.classList.toggle('is-active', this.sideFavOnly);
      this.el.sideFavFilterBtn.setAttribute('aria-pressed', String(this.sideFavOnly));
      this.renderCustomerBalances();
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
    let pressStartTs = 0;
    let startedOnThisPress = false;

    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pressStartTs = performance.now();

      // In Hands-Free mode, tapping while active finishes capture cleanly
      if (this.voice.listening) {
        startedOnThisPress = false;
        this.voice.stopListening({ graceMs: POST_RELEASE_TAIL_MS });
        return;
      }

      startedOnThisPress = true;
      this.voice.startListening({ tapMode: Boolean(this.state.settings.handsFree) });
    });

    const release = () => {
      if (!startedOnThisPress) return;
      startedOnThisPress = false;
      if (this.state.settings.handsFree || !this.voice.listening) return;

      const heldMs = performance.now() - pressStartTs;
      // Ignore accidental short presses (< 400ms); otherwise record 400ms post-release tail
      if (heldMs < MIN_PRESS_MS) {
        this.voice.discardListening('Press was too short — hold the mic button while speaking.');
      } else {
        this.voice.stopListening({ graceMs: POST_RELEASE_TAIL_MS });
      }
    };

    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
  }

  updateVolumeMeter(level = 0, lowVolume = false) {
    if (this.el.voiceVolumeFill) {
      const clamped = Math.max(0, Math.min(1, Number(level) || 0));
      this.el.voiceVolumeFill.style.transform = `scaleX(${clamped.toFixed(3)})`;
    }
    if (this.el.lowVolumeWarning) {
      this.el.lowVolumeWarning.hidden = !lowVolume;
    }
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

    if (!listening) {
      this.updateVolumeMeter(0, false);
    }

    if (this.el.holdTalkLabel) {
      this.el.holdTalkLabel.textContent = listening
        ? 'Listening… Release to Finish'
        : this.state.settings.handsFree
        ? t('voice.tapToSpeak')
        : 'Hold to Talk';
    }
    if (this.el.mobileHoldLabel) {
      this.el.mobileHoldLabel.textContent = listening
        ? 'Listening… Release to Finish'
        : this.state.settings.handsFree
        ? t('voice.tapToSpeak')
        : 'Hold to Talk';
    }

    if (this.el.voiceStateText) {
      this.el.voiceStateText.textContent = listening ? t('voice.listening') : t('voice.ready');
    }
  }

  setTranscript(text, isPlaceholder = false) {
    if (!this.el.liveTranscriptText) return;
    this.el.liveTranscriptText.textContent = text;
    this.el.liveTranscriptText.classList.toggle('is-placeholder', isPlaceholder);
    if (this.el.editLastTranscriptBtn) {
      this.el.editLastTranscriptBtn.hidden = Boolean(isPlaceholder || !this.lastRawTranscript);
    }
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
      this.state.customers.push({ name, optInReminder: false, isFavorite: false });
    }
  }

  isFavoriteCustomer(name) {
    const key = String(name || '').trim().toLowerCase();
    return this.state.customers.some((c) => c.name.toLowerCase() === key && Boolean(c.isFavorite));
  }

  async toggleFavoriteCustomer(name) {
    this.ensureCustomerExists(name);
    const rec = this.state.customers.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!rec) return;
    rec.isFavorite = !rec.isFavorite;
    await this.persistState();
    this.renderAll();
    this.showToast(rec.isFavorite ? `Added ${rec.name} to Favorites` : `Removed ${rec.name} from Favorites`);
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
        isFavorite: Boolean(c.isFavorite),
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
          isFavorite: false,
        });
      }
      const rec = map.get(key);
      if (e.type === 'credit') rec.credit += e.amount;
      else rec.paid += e.amount;
      rec.net = rec.credit - rec.paid;
      rec.count += 1;
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      return Math.abs(b.net) - Math.abs(a.net);
    });
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

  async handleUtterance(rawText, meta = {}) {
    const text = String(rawText || '').trim();
    if (!text) return;

    const parseContext = {
      customers: this.state.customers,
      entries: this.state.entries,
      pendingDisambiguation: this.pendingDisambiguation,
      referenceDate: new Date(),
      sttConfidence: meta.confidence ?? 0.95,
    };

    let chosenTranscript = text;
    let parsed;
    if (Array.isArray(meta.alternatives) && meta.alternatives.length > 1) {
      const best = pickBestTranscriptAlternative(meta.alternatives, parseContext);
      chosenTranscript = best.transcript || text;
      parsed = best.parsed;
    } else {
      parsed = parseUtterance(text, parseContext);
    }

    this.debugLog.add({
      transcript: chosenTranscript,
      normalized: parsed.raw,
      language: meta.lang || this.voice.speechLang,
      engine: meta.source || 'typed',
      parsed,
      confidence: parsed.confidence ?? meta.confidence ?? 0.95,
      rmsPeak: meta.rmsPeak ?? null,
    });
    this.renderDebugLog();

    this.lastRawTranscript = chosenTranscript;
    this.setTranscript(`"${chosenTranscript}"`, false);

    let replyText = parsed.reply || '';
    let replyTag = 'Voice Confirmation';

    if (parsed.intent === 'disambiguation_required') {
      this.pendingConfirmation = null;
      this.pendingDisambiguation = parsed;
      replyTag = 'Confirm Customer';
      replyText = parsed.reply;
      this.renderDisambiguationCard();
      this.renderConfirmationCard();
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
          uncertainMatch: false,
          confidence: Math.max(0.9, item.confidence || 0.9),
          lowConfidence: false,
          warnings: (item.warnings || []).filter((w) => !/Matched/i.test(w)),
        }));
        // Always show confirmation card before saving — never save silently
        this.openConfirmationCard(resolvedEntries, {
          rawTranscript: chosenTranscript,
          confidence: Math.min(...resolvedEntries.map((e) => e.confidence)),
          lowConfidence: resolvedEntries.some((e) => e.lowConfidence),
          warnings: Array.from(new Set(resolvedEntries.flatMap((e) => e.warnings || []))),
          meta,
        });
        replyTag = 'Confirm Entry';
        replyText = buildEntriesReply(resolvedEntries, { pendingConfirm: true });
      } else if (pending.forIntent === 'balance_query') {
        replyTag = 'Customer Balance';
        replyText = this.resolveBalanceQuery(selected);
      }
    } else if (parsed.intent === 'ledger_entries') {
      this.pendingDisambiguation = null;
      this.renderDisambiguationCard();
      // Always show confirmation card (customer, action, amount) with Confirm, Edit, Cancel — never save silently
      this.openConfirmationCard(parsed.entries, {
        rawTranscript: chosenTranscript,
        confidence: parsed.confidence ?? 0.9,
        lowConfidence: Boolean(parsed.lowConfidence),
        warnings: parsed.warnings || [],
        meta,
      });
      replyTag = parsed.lowConfidence ? 'Please Verify Entry' : 'Confirm Entry';
      replyText = buildEntriesReply(parsed.entries, { pendingConfirm: true });
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
    this.pendingConfirmation = null;
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
    this.renderConfirmationCard();
    if (this.activeView === 'reports') {
      this.reports.render();
    }
  }

  openConfirmationCard(entries, { rawTranscript, confidence, lowConfidence, warnings, meta } = {}) {
    this.pendingConfirmation = {
      entries: (entries || []).map((e) => ({
        ...e,
        action: e.action || (e.type === 'paid' ? 'PAYMENT' : 'CREDIT'),
      })),
      rawTranscript: rawTranscript || '',
      confidence: Number(confidence ?? 0.9),
      lowConfidence: Boolean(lowConfidence),
      warnings: Array.isArray(warnings) ? warnings : [],
      editing: false,
      meta: meta || {},
    };
    this.renderConfirmationCard();
  }

  toggleConfirmationEdit() {
    if (!this.pendingConfirmation) return;
    this.pendingConfirmation.editing = !this.pendingConfirmation.editing;
    this.renderConfirmationCard();
    if (this.pendingConfirmation.editing) {
      const firstInput = this.el.confirmEntriesList?.querySelector('input[data-edit-field="customerName"]');
      firstInput?.focus();
    }
  }

  cancelPendingConfirmation() {
    if (!this.pendingConfirmation) return;
    this.pendingConfirmation = null;
    this.renderConfirmationCard();
    this.setReply('Cancelled', 'Entry discarded. Nothing was saved.');
    this.showToast('Entry cancelled');
  }

  async readBackPendingConfirmation() {
    if (!this.pendingConfirmation) return;
    const summary = buildEntriesReply(this.pendingConfirmation.entries, { pendingConfirm: true });
    await this.voice.speak(summary, { muted: false });
  }

  async confirmPendingEntries() {
    if (!this.pendingConfirmation) return;
    const entries = this.pendingConfirmation.entries;
    for (const item of entries) {
      const cleanName = String(item.customerName || '').trim();
      const numAmt = Number(item.amount);
      if (!cleanName) {
        this.showToast('Please enter a customer name before saving.');
        if (!this.pendingConfirmation.editing) this.toggleConfirmationEdit();
        return;
      }
      if (!Number.isFinite(numAmt) || numAmt <= 0) {
        this.showToast('Please enter a valid positive amount.');
        if (!this.pendingConfirmation.editing) this.toggleConfirmationEdit();
        return;
      }
      item.customerName = cleanName;
      item.amount = Math.round(numAmt * 100) / 100;
      item.type = item.action === 'PAYMENT' ? 'paid' : 'credit';
      item.signedAmount = item.type === 'credit' ? item.amount : -item.amount;
    }

    const toCommit = entries.slice();
    this.pendingConfirmation = null;
    await this.commitParsedEntries(toCommit);
    const savedReply = buildEntriesReply(toCommit, { pendingConfirm: false });
    this.setReply(`Saved (${toCommit.length} ${toCommit.length === 1 ? 'entry' : 'entries'})`, savedReply);
    this.renderAll();
    this.showToast(savedReply);
    await this.voice.speak(savedReply, { muted: this.state.settings.muted });
  }

  renderConfirmationCard() {
    const card = this.el.confirmEntryCard;
    if (!card) return;

    const pending = this.pendingConfirmation;
    if (!pending || !pending.entries || pending.entries.length === 0) {
      card.hidden = true;
      card.classList.remove('is-low-confidence');
      return;
    }

    card.hidden = false;
    card.classList.toggle('is-low-confidence', pending.lowConfidence);

    const pct = Math.round((pending.confidence || 0) * 100);
    if (this.el.confirmCardTitle) {
      this.el.confirmCardTitle.textContent =
        pending.entries.length > 1
          ? `Confirm ${pending.entries.length} Ledger Entries`
          : 'Confirm Ledger Entry';
    }
    if (this.el.confirmConfidenceBadge) {
      this.el.confirmConfidenceBadge.textContent = pending.lowConfidence
        ? `Low confidence · ${pct}%`
        : `${pct}% confidence`;
    }
    if (this.el.confirmEditBtn) {
      this.el.confirmEditBtn.textContent = pending.editing ? 'Done Editing' : 'Edit';
    }

    // Populate customer datalist for quick name edits
    if (this.el.confirmCustomerDatalist) {
      const names = Array.from(new Set(this.state.customers.map((c) => c.name)));
      this.el.confirmCustomerDatalist.innerHTML = names
        .map((n) => `<option value="${escapeHtml(n)}"></option>`)
        .join('');
    }

    // Render highlighted warning banner for low-confidence or uncertain fuzzy matches
    if (this.el.confirmWarningBox) {
      const warnings = pending.warnings || [];
      const fuzzyEntries = pending.entries
        .map((e, idx) => ({ e, idx }))
        .filter(({ e }) => e.uncertainMatch && e.spokenName && e.spokenName.toLowerCase() !== e.customerName.toLowerCase());

      if (pending.lowConfidence || warnings.length > 0 || fuzzyEntries.length > 0) {
        const msgLines =
          warnings.length > 0
            ? warnings.map((w) => `<div>⚠ ${escapeHtml(w)}</div>`).join('')
            : '<div>⚠ Low confidence entry — please review customer, action, and amount before saving.</div>';
        const chipsHtml = fuzzyEntries
          .map(
            ({ e, idx }) =>
              `<button type="button" class="confirm-suggest-chip" data-use-spoken-idx="${idx}">Use &ldquo;${escapeHtml(
                e.spokenName
              )}&rdquo; instead</button>`
          )
          .join('');
        this.el.confirmWarningBox.innerHTML = `${msgLines}${chipsHtml}`;
        this.el.confirmWarningBox.hidden = false;
        this.el.confirmWarningBox.querySelectorAll('[data-use-spoken-idx]').forEach((chip) => {
          chip.addEventListener('click', () => {
            const i = Number(chip.dataset.useSpokenIdx);
            const target = this.pendingConfirmation?.entries?.[i];
            if (!target) return;
            target.customerName = target.spokenName;
            target.uncertainMatch = false;
            this.pendingConfirmation.warnings = (this.pendingConfirmation.warnings || []).filter(
              (w) => !w.includes(target.spokenName)
            );
            this.renderConfirmationCard();
          });
        });
      } else {
        this.el.confirmWarningBox.hidden = true;
        this.el.confirmWarningBox.innerHTML = '';
      }
    }

    // Render each parsed entry (display view or inline Edit form)
    if (this.el.confirmEntriesList) {
      this.el.confirmEntriesList.innerHTML = pending.entries
        .map((entry, idx) => {
          const isCredit = entry.action !== 'PAYMENT' && entry.type !== 'paid';
          if (pending.editing) {
            return `
              <div class="confirm-entry-row" data-confirm-idx="${idx}">
                <div class="confirm-edit-grid">
                  <div class="confirm-edit-field">
                    <label for="confirmName-${idx}">Customer</label>
                    <input
                      id="confirmName-${idx}"
                      type="text"
                      list="confirmCustomerDatalist"
                      value="${escapeHtml(entry.customerName)}"
                      data-edit-idx="${idx}"
                      data-edit-field="customerName"
                    />
                  </div>
                  <div class="confirm-edit-field">
                    <label for="confirmAction-${idx}">Action</label>
                    <select id="confirmAction-${idx}" data-edit-idx="${idx}" data-edit-field="action">
                      <option value="CREDIT" ${isCredit ? 'selected' : ''}>CREDIT (Udhaar / Dr)</option>
                      <option value="PAYMENT" ${!isCredit ? 'selected' : ''}>PAYMENT (Jama / Cr)</option>
                    </select>
                  </div>
                  <div class="confirm-edit-field">
                    <label for="confirmAmount-${idx}">Amount (₹)</label>
                    <input
                      id="confirmAmount-${idx}"
                      type="number"
                      min="1"
                      step="1"
                      value="${escapeHtml(String(entry.amount))}"
                      data-edit-idx="${idx}"
                      data-edit-field="amount"
                    />
                  </div>
                </div>
              </div>
            `;
          }

          return `
            <div class="confirm-entry-row" data-confirm-idx="${idx}">
              <div class="confirm-entry-main">
                <span class="confirm-entry-customer">${escapeHtml(entry.customerName)}</span>
                <span class="confirm-entry-meta">${escapeHtml(entry.dateLabel)} &middot; ${escapeHtml(entry.dateIso)}</span>
              </div>
              <div class="confirm-entry-right">
                <span class="confirm-action-badge ${
                  isCredit ? 'confirm-action-badge--credit' : 'confirm-action-badge--paid'
                }">${isCredit ? 'CREDIT' : 'PAYMENT'}</span>
                <span class="confirm-entry-amount tabular">${formatCurrencyInr(entry.amount)}</span>
              </div>
            </div>
          `;
        })
        .join('');

      if (pending.editing) {
        this.el.confirmEntriesList.querySelectorAll('[data-edit-idx]').forEach((control) => {
          control.addEventListener('input', () => {
            const idx = Number(control.dataset.editIdx);
            const field = control.dataset.editField;
            const target = this.pendingConfirmation?.entries?.[idx];
            if (!target) return;
            if (field === 'amount') {
              target.amount = Number(control.value);
            } else if (field === 'action') {
              target.action = control.value === 'PAYMENT' ? 'PAYMENT' : 'CREDIT';
              target.type = target.action === 'PAYMENT' ? 'paid' : 'credit';
            } else if (field === 'customerName') {
              target.customerName = control.value;
            }
          });
        });
      }
    }
  }

  renderDebugLog() {
    if (!this.debugLog.enabled || !this.el.voiceDebugDrawer) return;
    const records = this.debugLog.getRecords();
    if (this.el.voiceDebugCount) this.el.voiceDebugCount.textContent = String(records.length);
    if (!this.el.voiceDebugList) return;
    if (records.length === 0) {
      this.el.voiceDebugList.innerHTML = '<div class="voice-debug-item">No voice events logged yet.</div>';
      return;
    }
    this.el.voiceDebugList.innerHTML = records
      .map(
        (r) => `
          <div class="voice-debug-item">
            <strong>[${escapeHtml(r.language)} · ${escapeHtml(r.engine)}]</strong>
            &ldquo;${escapeHtml(r.transcript)}&rdquo;
            &rarr; <em>${escapeHtml(r.intent)}</em>
            (conf: ${Math.round((r.confidence || 0) * 100)}%${r.lowConfidence ? ' LOW' : ''})
            ${
              r.entries.length > 0
                ? `<br/>${escapeHtml(
                    r.entries.map((e) => `${e.customerName} ${e.action} ₹${e.amount} (${Math.round((e.confidence || 0) * 100)}%)`).join(' | ')
                  )}`
                : ''
            }
          </div>
        `
      )
      .join('');
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
        if (this.activeFilter === 'favorites' && !this.isFavoriteCustomer(e.customerName)) return false;
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
                  ${this.isFavoriteCustomer(entry.customerName) ? '<span class="ledger-fav-badge" title="Favorite customer" aria-label="Favorite customer">★</span>' : ''}
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
      const sideList = this.sideFavOnly ? balances.filter((c) => c.isFavorite) : balances;
      if (sideList.length === 0) {
        this.el.sideBalancesList.innerHTML = `<li class="balance-item"><span class="balance-item-sub">${
          this.sideFavOnly
            ? 'No favorite customers yet. Tap ★ next to a customer to pin them.'
            : 'No customers yet. Speak your first entry.'
        }</span></li>`;
      } else {
        this.el.sideBalancesList.innerHTML = sideList
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
                <div class="balance-item-main">
                  <button
                    type="button"
                    class="fav-star-btn fav-star-btn--sm ${c.isFavorite ? 'is-fav' : ''}"
                    data-fav-toggle="${escapeHtml(c.name)}"
                    aria-pressed="${c.isFavorite ? 'true' : 'false'}"
                    aria-label="${c.isFavorite ? `Remove ${escapeHtml(c.name)} from favorites` : `Add ${escapeHtml(c.name)} to favorites`}"
                    title="${c.isFavorite ? 'Remove favorite' : 'Mark as favorite'}"
                  >${c.isFavorite ? '★' : '☆'}</button>
                  <div>
                    <div class="balance-item-name">${escapeHtml(c.name)}</div>
                    <div class="balance-item-sub tabular">${c.count} ${c.count === 1 ? 'entry' : 'entries'}${c.optInReminder ? ' · Reminder opt-in' : ''}</div>
                  </div>
                </div>
                <span class="balance-pill ${pillClass} tabular">${pillLabel}</span>
              </li>
            `;
          })
          .join('');

        this.el.sideBalancesList.querySelectorAll('[data-fav-toggle]').forEach((starBtn) => {
          starBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleFavoriteCustomer(starBtn.dataset.favToggle);
          });
        });

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
      const detailList = balances.filter((c) => {
        if (this.customerFilter === 'favorites' && !c.isFavorite) return false;
        if (this.customerFilter === 'owes' && !(c.net > 0)) return false;
        if (this.customerFilter === 'settled' && c.net !== 0) return false;
        if (this.customerFilter === 'advance' && !(c.net < 0)) return false;
        if (this.customerSearchQuery && !c.name.toLowerCase().includes(this.customerSearchQuery)) {
          return false;
        }
        return true;
      });

      if (detailList.length === 0) {
        this.el.customersDetailList.innerHTML =
          balances.length === 0
            ? `<div class="empty-state"><h3>No customers yet</h3><p>Tap the mic and speak a customer name and amount to create their khata automatically.</p></div>`
            : `<div class="empty-state"><h3>No matching customers</h3><p>${
                this.customerFilter === 'favorites'
                  ? 'Tap the ★ star next to any customer to add them to Favorites.'
                  : 'Try another filter or clear your customer search.'
              }</p></div>`;
      } else {
        this.el.customersDetailList.innerHTML = detailList
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
                <div class="customer-detail-left">
                  <button
                    type="button"
                    class="fav-star-btn ${c.isFavorite ? 'is-fav' : ''}"
                    data-fav-toggle="${escapeHtml(c.name)}"
                    aria-pressed="${c.isFavorite ? 'true' : 'false'}"
                    aria-label="${c.isFavorite ? `Remove ${escapeHtml(c.name)} from favorites` : `Add ${escapeHtml(c.name)} to favorites`}"
                    title="${c.isFavorite ? 'Remove favorite' : 'Mark as favorite'}"
                  >${c.isFavorite ? '★' : '☆'}</button>
                  <div>
                    <div class="ledger-customer-name">${escapeHtml(c.name)}</div>
                    <div class="ledger-meta tabular">Dr ${formatCurrencyInr(c.credit)} &middot; Cr ${formatCurrencyInr(c.paid)} &middot; ${c.count} ${c.count === 1 ? 'entry' : 'entries'}</div>
                  </div>
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

        this.el.customersDetailList.querySelectorAll('[data-fav-toggle]').forEach((starBtn) => {
          starBtn.addEventListener('click', () => {
            this.toggleFavoriteCustomer(starBtn.dataset.favToggle);
          });
        });

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
