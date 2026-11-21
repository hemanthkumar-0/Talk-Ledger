/**
 * TalkLedger 3D Voice + Typing Auth Controller (public/src/auth.js)
 * SECURITY INVARIANTS:
 * - Voice mic button ONLY on Full Name and Email — NEVER on Password, Confirm Password, PIN, or OTP.
 * - Audio and form transcripts stay strictly in memory and are NEVER saved or logged.
 * - Never auto-submits from voice; user always sees & confirms/edits recognized values.
 * - Generic auth errors + 5-failed-attempts client cooldown.
 */

import {
  getActiveSession,
  initAuthClient,
  resetPasswordForEmail,
  signInWithOtp,
  signInWithPassword,
  signOut,
  signUp,
  verifyEmailOtp,
  verifyShopPin,
} from '../db.js';
import {
  normalizeSpokenEmail,
  normalizeSpokenName,
} from '../voice-fields.js';
import { AuthScene3D } from './auth-scene.js';
import { getActiveLanguage, SUPPORTED_LANGUAGES, t } from './i18n.js';

const MAX_RECORD_MS = 15000;
const MAX_FAILED_ATTEMPTS = 5;
const COOLDOWN_SECONDS = 30;

function evaluatePasswordStrength(pw) {
  if (!pw) return { score: 0, key: 'weak' };
  let pts = 0;
  if (pw.length >= 8) pts += 1;
  if (pw.length >= 12) pts += 1;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) pts += 1;
  if (/\d/.test(pw)) pts += 1;
  if (/[^A-Za-z0-9]/.test(pw)) pts += 1;

  if (pts <= 1) return { score: 1, key: 'weak' };
  if (pts === 2) return { score: 2, key: 'fair' };
  if (pts === 3 || pts === 4) return { score: 3, key: 'good' };
  return { score: 4, key: 'strong' };
}

export class AuthController {
  constructor(app) {
    this.app = app;
    this.mode = 'login'; // 'login' | 'signup' | 'otp' | 'pin'
    this.speakLang = getActiveLanguage();
    this.scene3d = null;
    this.activeMicField = null;
    this.recordTimer = null;
    this.recognition = null;
    this.micStream = null;
    this.micCtx = null;
    this.volumeRaf = null;
    this.guidedActive = false;
    this.guidedStep = null; // 'name' | 'email' | 'password'
    this.failedAttempts = 0;
    this.cooldownUntil = 0;
    this.cooldownTimer = null;
    this.isOpen = false;
  }

  async open(defaultTab = 'login') {
    this.overlay = document.getElementById('authOverlay');
    if (!this.overlay) return;

    this.mode = defaultTab;
    this.speakLang = getActiveLanguage();
    this.isOpen = true;
    this.overlay.hidden = false;
    document.body.classList.add('is-auth-open');

    await initAuthClient();
    this.render();

    // Lazy-load 3D scene strictly AFTER the auth form is already rendered & interactive
    if (this.scene3d) {
      this.scene3d.dispose();
    }
    const mount = document.getElementById('auth3dMount');
    const badge = document.getElementById('auth3dStateBadge');
    this.scene3d = new AuthScene3D(mount, badge);
    setTimeout(() => {
      if (this.isOpen) this.scene3d?.init();
    }, 60);
  }

  close() {
    this.stopFieldRecording();
    this.guidedActive = false;
    this.isOpen = false;
    if (this.scene3d) {
      this.scene3d.dispose();
      this.scene3d = null;
    }
    if (this.overlay) this.overlay.hidden = true;
    document.body.classList.remove('is-auth-open');
    this.app.syncAccountHeader();
  }

  announce(text) {
    const live = document.getElementById('authLiveRegion');
    if (live) live.textContent = text;
  }

  setError(msg) {
    const box = document.getElementById('authErrorBox');
    if (!box) return;
    if (!msg) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.textContent = msg;
    this.scene3d?.setState('error');
  }

  setInfo(msg) {
    const box = document.getElementById('authInfoBox');
    if (!box) return;
    if (!msg) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.textContent = msg;
  }

  render() {
    if (!this.overlay) return;
    const isSignup = this.mode === 'signup';
    const isPin = this.mode === 'pin';
    const isOtp = this.mode === 'otp';
    const session = getActiveSession();

    const speechSupported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    const speakLangMeta = SUPPORTED_LANGUAGES.find((l) => l.code === this.speakLang) || SUPPORTED_LANGUAGES[0];

    this.overlay.innerHTML = `
      <div class="auth-shell">
        <!-- Left / Top Decorative 3D Scene Panel -->
        <div class="auth-scene-pane">
          <div class="auth-scene-top">
            <span class="auth-brand-mini">Voice <span>Khata</span></span>
            <span class="auth-state-pill" id="auth3dStateBadge" data-state="idle">Ready</span>
          </div>
          <div class="auth-3d-mount" id="auth3dMount" aria-hidden="true"></div>
          <div class="auth-scene-footer">
            <p class="auth-mic-privacy-note">${t('voice.micNotice')}</p>
            <button type="button" class="auth-tilt-btn" id="authEnableTiltBtn">${t('auth.enableTilt')}</button>
          </div>
        </div>

        <!-- Right / Main Accessible Auth Form Pane -->
        <div class="auth-form-pane">
          <div class="auth-form-top">
            <div>
              <h2 id="authModalTitle">${isPin ? t('auth.pinTitle') : t('auth.pageTitle')}</h2>
              <p class="auth-sub">${isPin ? t('auth.pinSub') : t('auth.pageSub')}</p>
            </div>
            <button type="button" class="btn-secondary auth-back-btn" id="authCloseBtn">${t('auth.continueShop')}</button>
          </div>

          <div class="sr-only" id="authLiveRegion" aria-live="polite" aria-atomic="true"></div>

          ${
            isPin
              ? `
            <form id="authPinForm" class="auth-form" autocomplete="off">
              <div class="auth-field">
                <label for="authPinInput">${t('auth.pinTitle')}</label>
                <input
                  type="password"
                  inputmode="numeric"
                  maxlength="4"
                  pattern="[0-9]{4}"
                  id="authPinInput"
                  class="auth-input tabular"
                  autocomplete="one-time-code"
                  placeholder="${t('auth.pinPlaceholder')}"
                  required
                />
                <span class="auth-field-hint">${t('auth.passwordTypedOnly')}</span>
              </div>
              <div class="auth-alert auth-alert--error" id="authErrorBox" hidden role="alert"></div>
              <button type="submit" class="btn-primary auth-submit-btn">${t('auth.pinUnlock')}</button>
            </form>
          `
              : `
            <!-- Log in / Sign up Tabs -->
            <div class="auth-tabs" role="tablist">
              <button type="button" role="tab" class="auth-tab ${this.mode === 'login' || isOtp ? 'is-active' : ''}" aria-selected="${this.mode === 'login' || isOtp}" data-auth-tab="login">${t('auth.tabLogin')}</button>
              <button type="button" role="tab" class="auth-tab ${isSignup ? 'is-active' : ''}" aria-selected="${isSignup}" data-auth-tab="signup">${t('auth.tabSignup')}</button>
            </div>

            <!-- Speak-In Language Dropdown + Guided "Fill with voice" Trigger -->
            <div class="auth-voice-bar">
              <label class="auth-speak-lang">
                <span>${t('lang.speakIn')}</span>
                <select id="authSpeakLangSelect">
                  ${SUPPORTED_LANGUAGES.map(
                    (l) => `<option value="${l.code}" ${l.code === this.speakLang ? 'selected' : ''}>${l.label}</option>`
                  ).join('')}
                </select>
              </label>

              <button type="button" class="auth-guided-btn ${this.guidedActive ? 'is-on' : ''}" id="authGuidedBtn">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                </svg>
                <span>${this.guidedActive ? t('auth.stopGuided') : t('auth.fillWithVoice')}</span>
              </button>
            </div>

            ${
              !speechSupported || !speakLangMeta.voiceSupported
                ? `<p class="auth-voice-note">${t('lang.voiceUnsupported')}</p>`
                : ''
            }

            <!-- Guided Voice Confirmation Strip -->
            <div class="auth-guided-card" id="authGuidedCard" hidden>
              <p id="authGuidedPrompt"></p>
              <div class="auth-guided-actions">
                <button type="button" class="btn-primary" id="authGuidedYesBtn">${t('auth.yes')}</button>
                <button type="button" class="btn-secondary" id="authGuidedEditBtn">${t('auth.edit')}</button>
              </div>
            </div>

            <div class="auth-alert auth-alert--error" id="authErrorBox" hidden role="alert"></div>
            <div class="auth-alert auth-alert--info" id="authInfoBox" hidden role="status"></div>

            <form id="authMainForm" class="auth-form" novalidate>
              ${
                isSignup
                  ? `
                <div class="auth-field">
                  <label for="authNameInput">${t('auth.fullName')}</label>
                  <div class="auth-input-wrap">
                    <input type="text" id="authNameInput" class="auth-input" autocomplete="name" required />
                    <button type="button" class="field-mic-btn" data-mic-field="name" aria-label="${t('auth.micAriaName')}" title="${t('auth.micAriaName')}">
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                      </svg>
                    </button>
                  </div>
                </div>
              `
                  : ''
              }

              <div class="auth-field">
                <label for="authEmailInput">${t('auth.email')}</label>
                <div class="auth-input-wrap">
                  <input type="email" id="authEmailInput" class="auth-input" autocomplete="email" required />
                  <button type="button" class="field-mic-btn" data-mic-field="email" aria-label="${t('auth.micAriaEmail')}" title="${t('auth.micAriaEmail')}">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                    </svg>
                  </button>
                </div>
                <div class="domain-suggest-row" id="authDomainSuggest" hidden></div>
              </div>

              ${
                isOtp
                  ? `
                <!-- TYPED-ONLY OTP LOGIN CODE (NEVER HAS A MIC BUTTON) -->
                <div class="auth-field">
                  <label for="authOtpInput">${t('auth.otpLabel')}</label>
                  <input type="text" inputmode="numeric" maxlength="6" id="authOtpInput" class="auth-input tabular" autocomplete="one-time-code" required />
                  <span class="auth-field-hint">${t('auth.passwordTypedOnly')}</span>
                </div>
                <button type="submit" class="btn-primary auth-submit-btn" id="authSubmitBtn">${t('auth.verifyOtpBtn')}</button>
              `
                  : `
                <!-- TYPED-ONLY PASSWORD (NEVER HAS A MIC BUTTON) -->
                <div class="auth-field">
                  <label for="authPasswordInput">${t('auth.password')}</label>
                  <div class="auth-input-wrap">
                    <input
                      type="password"
                      id="authPasswordInput"
                      class="auth-input"
                      autocomplete="${isSignup ? 'new-password' : 'current-password'}"
                      required
                    />
                    <button type="button" class="field-eye-btn" data-toggle-pw="authPasswordInput" aria-label="${t('auth.showPassword')}">
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path>
                        <circle cx="12" cy="12" r="3"></circle>
                      </svg>
                    </button>
                  </div>
                  <div class="pw-strength-bar" id="pwStrengthBar" ${isSignup ? '' : 'hidden'}>
                    <div class="pw-strength-fill" id="pwStrengthFill"></div>
                    <span class="pw-strength-label" id="pwStrengthLabel"></span>
                  </div>
                  <span class="auth-field-hint">${t('auth.passwordTypedOnly')}</span>
                </div>

                ${
                  isSignup
                    ? `
                  <!-- TYPED-ONLY CONFIRM PASSWORD (NEVER HAS A MIC BUTTON) -->
                  <div class="auth-field">
                    <label for="authConfirmPasswordInput">${t('auth.confirmPassword')}</label>
                    <div class="auth-input-wrap">
                      <input type="password" id="authConfirmPasswordInput" class="auth-input" autocomplete="new-password" required />
                      <button type="button" class="field-eye-btn" data-toggle-pw="authConfirmPasswordInput" aria-label="${t('auth.showPassword')}">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path>
                          <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                      </button>
                    </div>
                  </div>

                  <label class="auth-terms-check">
                    <input type="checkbox" id="authTermsCheckbox" />
                    <span>
                      ${t('auth.acceptTerms')}
                      (<a href="/terms" target="_blank" rel="noopener">${t('auth.termsLink')}</a> &middot;
                      <a href="/privacy" target="_blank" rel="noopener">${t('auth.privacyLink')}</a>)
                    </span>
                  </label>
                `
                    : ''
                }

                <button type="submit" class="btn-primary auth-submit-btn" id="authSubmitBtn">
                  ${isSignup ? t('auth.submitSignup') : t('auth.submitLogin')}
                </button>
              `
              }
            </form>

            ${
              !isSignup
                ? `
              <div class="auth-secondary-actions">
                <button type="button" class="auth-link-btn" id="authEmailOtpBtn">${t('auth.emailOtpBtn')}</button>
                <button type="button" class="auth-link-btn" id="authForgotBtn">${t('auth.forgotPassword')}</button>
              </div>
            `
                : ''
            }

            ${
              session
                ? `<div class="auth-session-foot">Signed in as <strong>${session.email}</strong> <button type="button" class="auth-link-btn" id="authSignOutBtn">Sign out</button></div>`
                : ''
            }
          `
          }
        </div>
      </div>
    `;

    this.bindHandlers();
  }

  bindHandlers() {
    document.getElementById('authCloseBtn')?.addEventListener('click', () => this.close());
    document.getElementById('authEnableTiltBtn')?.addEventListener('click', async () => {
      const ok = await this.scene3d?.enableTiltParallax();
      this.app.showToast(ok ? 'Tilt parallax enabled' : 'Tilt sensor unavailable on this device');
    });

    // Tab switching
    this.overlay.querySelectorAll('[data-auth-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.mode = tab.dataset.authTab;
        this.render();
      });
    });

    // Speak-in language selector
    document.getElementById('authSpeakLangSelect')?.addEventListener('change', (e) => {
      this.speakLang = e.target.value;
    });

    // Typing reactivity on 3D scene
    this.overlay.querySelectorAll('.auth-input').forEach((inp) => {
      inp.addEventListener('focus', () => this.scene3d?.setState('typing'));
      inp.addEventListener('blur', () => {
        if (!this.activeMicField) this.scene3d?.setState('idle');
      });
    });

    // Password strength meter
    document.getElementById('authPasswordInput')?.addEventListener('input', (e) => {
      const res = evaluatePasswordStrength(e.target.value);
      const fill = document.getElementById('pwStrengthFill');
      const lbl = document.getElementById('pwStrengthLabel');
      if (fill) {
        fill.style.width = `${res.score * 25}%`;
        fill.dataset.level = res.key;
      }
      if (lbl) lbl.textContent = e.target.value ? t(`auth.strength.${res.key}`) : '';
    });

    // Password show/hide toggles
    this.overlay.querySelectorAll('[data-toggle-pw]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.togglePw);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-label', show ? t('auth.hidePassword') : t('auth.showPassword'));
      });
    });

    // Push-to-talk mic buttons ONLY on Name and Email fields
    this.overlay.querySelectorAll('[data-mic-field]').forEach((btn) => {
      const field = btn.dataset.micField;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.startFieldRecording(field, btn);
      });
      const stop = () => {
        if (this.activeMicField === field) this.stopFieldRecording();
      };
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointercancel', stop);
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (this.activeMicField === field) this.stopFieldRecording();
          else this.startFieldRecording(field, btn);
        }
      });
    });

    // Guided 'Fill with voice' mode
    document.getElementById('authGuidedBtn')?.addEventListener('click', () => {
      if (this.guidedActive) {
        this.guidedActive = false;
        this.stopFieldRecording();
        this.render();
      } else {
        this.startGuidedVoiceFlow();
      }
    });

    // Email OTP & Forgot password
    document.getElementById('authEmailOtpBtn')?.addEventListener('click', async () => {
      const email = document.getElementById('authEmailInput')?.value.trim();
      if (!email || !email.includes('@')) {
        this.setError(t('auth.errors.invalidEmail'));
        return;
      }
      this.setError('');
      await signInWithOtp({ email });
      this.mode = 'otp';
      this.render();
      const emailEl = document.getElementById('authEmailInput');
      if (emailEl) emailEl.value = email;
      this.setInfo(t('auth.errors.otpSent'));
      document.getElementById('authOtpInput')?.focus();
    });

    document.getElementById('authForgotBtn')?.addEventListener('click', async () => {
      const email = document.getElementById('authEmailInput')?.value.trim();
      if (!email || !email.includes('@')) {
        this.setError(t('auth.errors.invalidEmail'));
        return;
      }
      this.setError('');
      await resetPasswordForEmail({ email });
      this.setInfo(t('auth.errors.resetSent'));
    });

    document.getElementById('authSignOutBtn')?.addEventListener('click', () => {
      signOut();
      this.app.syncAccountHeader();
      this.render();
    });

    // Main Auth Form Submit
    document.getElementById('authMainForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSubmit();
    });

    // Post-login Shop PIN Submit
    document.getElementById('authPinForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = document.getElementById('authPinInput')?.value || '';
      const ok = await verifyShopPin(pin);
      if (!ok) {
        this.setError(t('auth.errors.invalidPin'));
        return;
      }
      this.scene3d?.setState('success');
      setTimeout(() => this.close(), 700);
    });

    // Escape stops recording
    this._onKey = (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape' && this.activeMicField) {
        this.stopFieldRecording();
      }
    };
    window.addEventListener('keydown', this._onKey);
  }

  async startFieldRecording(field, btnEl) {
    if (field !== 'name' && field !== 'email') return; // Strict security whitelist!
    this.setError('');
    this.activeMicField = field;
    btnEl?.classList.add('is-recording');
    this.scene3d?.setState('listening');
    this.scene3d?.setMicVolume(0.32);
    this.announce(t('voice.listening'));

    // Hard 15-second max cap per security specification
    clearTimeout(this.recordTimer);
    this.recordTimer = setTimeout(() => this.stopFieldRecording(), MAX_RECORD_MS);

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const langMeta = SUPPORTED_LANGUAGES.find((l) => l.code === this.speakLang) || SUPPORTED_LANGUAGES[0];

    if (!SpeechRec) {
      this.setInfo(t('lang.voiceUnsupported'));
      this.stopFieldRecording();
      return;
    }

    // Start SpeechRecognition synchronously without a competing getUserMedia lock
    let capturedText = '';
    try {
      const rec = new SpeechRec();
      rec.lang = langMeta.sttLang;
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 3;
      rec.onsoundstart = () => this.scene3d?.setMicVolume(0.6);
      rec.onspeechstart = () => this.scene3d?.setMicVolume(0.88);
      rec.onspeechend = () => this.scene3d?.setMicVolume(0.25);
      rec.onresult = (ev) => {
        let txt = '';
        for (let i = 0; i < ev.results.length; i += 1) {
          txt += (txt ? ' ' : '') + (ev.results[i]?.[0]?.transcript || '');
        }
        if (txt.trim()) {
          capturedText = txt.trim();
          this.scene3d?.setMicVolume(0.95);
        }
      };
      rec.onerror = (ev) => {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          this.setError(t('auth.errors.micDenied'));
        } else if (ev.error === 'network') {
          this.setError(t('auth.errors.networkFail'));
        } else if (ev.error === 'no-speech') {
          this.setError(t('auth.errors.emptyAudio'));
        }
      };
      rec.onend = async () => {
        const finishedField = this.activeMicField || field;
        this.cleanupMicResources();
        if (!capturedText.trim()) {
          this.scene3d?.setState('idle');
          return;
        }
        this.scene3d?.setState('processing');
        this.announce(t('voice.processing'));
        await this.applyRecognizedField(finishedField, capturedText);
      };
      this.recognition = rec;
      rec.start();
    } catch {
      this.setError(t('auth.errors.networkFail'));
      this.stopFieldRecording();
    }
  }

  stopFieldRecording() {
    clearTimeout(this.recordTimer);
    this.overlay?.querySelectorAll('.field-mic-btn.is-recording').forEach((b) => b.classList.remove('is-recording'));
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // ignore
      }
      this.recognition = null;
    }
    this.cleanupMicResources();
  }

  cleanupMicResources() {
    this.activeMicField = null;
    if (this.volumeRaf) {
      window.cancelAnimationFrame(this.volumeRaf);
      this.volumeRaf = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((tr) => tr.stop());
      this.micStream = null;
    }
    if (this.micCtx) {
      this.micCtx.close().catch(() => undefined);
      this.micCtx = null;
    }
    this.scene3d?.setMicVolume(0);
  }

  async applyRecognizedField(field, rawTranscript) {
    if (field === 'name') {
      const normalized = normalizeSpokenName(rawTranscript, this.speakLang);
      const input = document.getElementById('authNameInput');
      if (input) input.value = normalized;
      this.announce(normalized);
      this.scene3d?.setState('idle');
      if (this.guidedActive) {
        this.showGuidedConfirm('name', normalized, normalized);
      }
    } else if (field === 'email') {
      const res = normalizeSpokenEmail(rawTranscript, this.speakLang);
      const input = document.getElementById('authEmailInput');
      if (input) input.value = res.email;
      this.announce(res.email);

      const suggestBox = document.getElementById('authDomainSuggest');
      if (suggestBox) {
        if (res.suggestion) {
          suggestBox.hidden = false;
          suggestBox.innerHTML = `<button type="button" class="domain-chip" id="acceptDomainBtn">${t('auth.domainSuggest', { email: res.suggestion })}</button>`;
          document.getElementById('acceptDomainBtn')?.addEventListener('click', () => {
            if (input) input.value = res.suggestion;
            suggestBox.hidden = true;
            this.setError('');
          });
        } else {
          suggestBox.hidden = true;
          suggestBox.innerHTML = '';
        }
      }

      if (!res.valid) {
        this.setError(t('auth.errors.invalidEmail'));
      } else {
        this.setError('');
        this.scene3d?.setState('idle');
      }

      if (this.guidedActive) {
        this.showGuidedConfirm('email', res.email, res.readback);
      }
    }
    // Discard rawTranscript immediately — never logged or persisted!
  }

  async startGuidedVoiceFlow() {
    this.guidedActive = true;
    const btn = document.getElementById('authGuidedBtn');
    if (btn) btn.classList.add('is-on');

    const startField = this.mode === 'signup' ? 'name' : 'email';
    await this.promptGuidedStep(startField);
  }

  async promptGuidedStep(step) {
    this.guidedStep = step;
    const card = document.getElementById('authGuidedCard');
    const promptEl = document.getElementById('authGuidedPrompt');

    if (step === 'password') {
      const msg = t('auth.guidedAskPassword');
      if (card && promptEl) {
        card.hidden = false;
        promptEl.textContent = msg;
      }
      await this.app.voice.speak(msg, { muted: this.app.state.settings.muted });
      document.getElementById('authPasswordInput')?.focus();
      this.guidedActive = false;
      return;
    }

    const ask = step === 'name' ? t('auth.guidedAskName') : t('auth.guidedAskEmail');
    if (card && promptEl) {
      card.hidden = false;
      promptEl.textContent = ask;
    }
    await this.app.voice.speak(ask, { muted: this.app.state.settings.muted });
    const targetMic = this.overlay?.querySelector(`[data-mic-field="${step}"]`);
    if (targetMic) targetMic.focus();
  }

  async showGuidedConfirm(step, displayValue, spokenReadback) {
    const card = document.getElementById('authGuidedCard');
    const promptEl = document.getElementById('authGuidedPrompt');
    const yesBtn = document.getElementById('authGuidedYesBtn');
    const editBtn = document.getElementById('authGuidedEditBtn');

    if (card && promptEl) {
      card.hidden = false;
      promptEl.textContent = t('auth.guidedConfirm', { value: displayValue });
    }
    await this.app.voice.speak(t('auth.guidedConfirm', { value: spokenReadback }), {
      muted: this.app.state.settings.muted,
    });

    if (yesBtn) {
      yesBtn.onclick = () => {
        if (step === 'name') this.promptGuidedStep('email');
        else this.promptGuidedStep('password');
      };
    }
    if (editBtn) {
      editBtn.onclick = () => {
        const input = document.getElementById(step === 'name' ? 'authNameInput' : 'authEmailInput');
        input?.focus();
        input?.select();
      };
    }
  }

  startCooldownCheck() {
    const remaining = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
    if (remaining > 0) {
      this.setError(t('auth.errors.cooldown', { seconds: remaining }));
      return true;
    }
    return false;
  }

  recordFailedAttempt() {
    this.failedAttempts += 1;
    if (this.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      this.cooldownUntil = Date.now() + COOLDOWN_SECONDS * 1000;
      this.failedAttempts = 0;
      clearInterval(this.cooldownTimer);
      this.cooldownTimer = setInterval(() => {
        const rem = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
        if (rem <= 0) {
          clearInterval(this.cooldownTimer);
          this.setError('');
        } else {
          this.setError(t('auth.errors.cooldown', { seconds: rem }));
        }
      }, 1000);
    }
  }

  async handleSubmit() {
    if (this.startCooldownCheck()) return;
    this.setError('');
    this.setInfo('');

    const email = (document.getElementById('authEmailInput')?.value || '').trim();
    const emailOk = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(email);

    if (this.mode === 'otp') {
      const token = (document.getElementById('authOtpInput')?.value || '').trim();
      if (!emailOk || !token) {
        this.setError(t('auth.errors.emptyFields'));
        return;
      }
      this.scene3d?.setState('processing');
      const res = await verifyEmailOtp({ email, token });
      if (!res.ok) {
        this.recordFailedAttempt();
        this.setError(t('auth.errors.invalidCredentials'));
        return;
      }
      this.scene3d?.setState('success');
      setTimeout(() => {
        this.mode = 'pin';
        this.render();
      }, 650);
      return;
    }

    const password = document.getElementById('authPasswordInput')?.value || '';

    if (this.mode === 'signup') {
      const name = (document.getElementById('authNameInput')?.value || '').trim();
      const confirmPw = document.getElementById('authConfirmPasswordInput')?.value || '';
      const termsChecked = Boolean(document.getElementById('authTermsCheckbox')?.checked);

      if (!name || !email || !password || !confirmPw) {
        this.setError(t('auth.errors.emptyFields'));
        return;
      }
      if (!emailOk) {
        this.setError(t('auth.errors.invalidEmail'));
        return;
      }
      if (password.length < 8) {
        this.setError(t('auth.errors.passwordShort'));
        return;
      }
      if (password !== confirmPw) {
        this.setError(t('auth.errors.passwordMismatch'));
        return;
      }
      if (!termsChecked) {
        this.setError(t('auth.errors.termsRequired'));
        return;
      }

      this.scene3d?.setState('processing');
      const res = await signUp({ name, email, password });
      if (!res.ok) {
        this.recordFailedAttempt();
        this.setError(t('auth.errors.invalidCredentials'));
        return;
      }
      this.scene3d?.setState('success');
      if (res.needsConfirmation) {
        this.setInfo('Account created. Check your email to confirm your address, then log in.');
        return;
      }
      setTimeout(() => {
        this.mode = 'pin';
        this.render();
      }, 650);
      return;
    }

    // Log in flow
    if (!email || !password) {
      this.setError(t('auth.errors.emptyFields'));
      return;
    }
    if (!emailOk) {
      this.setError(t('auth.errors.invalidEmail'));
      return;
    }

    this.scene3d?.setState('processing');
    const res = await signInWithPassword({ email, password });
    if (!res.ok) {
      this.recordFailedAttempt();
      this.setError(t('auth.errors.invalidCredentials'));
      return;
    }

    this.scene3d?.setState('success');
    setTimeout(() => {
      this.mode = 'pin';
      this.render();
    }, 650);
  }
}
