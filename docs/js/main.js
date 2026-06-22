/**
 * main.js
 *
 * Boot des Experiments:
 *   - URL-Parameter parsen (?condition=...)
 *   - sequences.json laden
 *   - DOM-Events an die experiment-Engine binden
 *   - Screen-Routing (welcome -> phase-intro -> trial -> end)
 *
 * Diese Datei ist der einzige Ort mit direktem DOM-Zugriff —
 * die anderen Module sind UI-frei.
 */
(function () {
  'use strict';

  const VALID_CONDITIONS = ['direct', 'strategy', 'reflective', 'control'];

  // DOM-Referenzen (einmal cachen).
  const $ = (id) => document.getElementById(id);
  const screens = {
    consent:      () => $('screen-consent'),
    welcome:      () => $('screen-welcome'),
    phaseIntro:   () => $('screen-phase-intro'),
    trial:        () => $('screen-trial'),
    instructions: () => $('screen-instructions'),
    quiz:         () => $('screen-quiz'),
    survey:       () => $('screen-survey'),
    end:          () => $('screen-end'),
    error:        () => $('screen-error')
  };

  // Korrekte Antworten für den Quiz — geändert werden? Hier eintragen.
  const QUIZ_ANSWERS = {
    'quiz-q1': 'correct_and_fast',
    'quiz-q2': 'next_zero',
    'quiz-q3': 'training'
  };

  // Wird zwischen showSurvey() und showEnd() gemerkt, damit die Endscreen-
  // Zusammenfassung beim Survey-Submit noch verfügbar ist.
  let pendingSummary = null;

  // Beim DOMContentLoaded los.
  document.addEventListener('DOMContentLoaded', boot);

  // Theme-Init synchron beim Laden — Scripts stehen am Body-Ende, also ist
  // der Body schon da. Direktes setAttribute verhindert das hell-/dunkel-
  // Flackern, das ein DOMContentLoaded-Handler verursachen würde.
  initTheme();

  function initTheme() {
    let theme = 'dark';
    try {
      const saved = localStorage.getItem('hig-theme');
      if (saved === 'light' || saved === 'dark') theme = saved;
    } catch (_) { /* localStorage gesperrt — ignorieren */ }
    applyTheme(theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const current = document.body.getAttribute('data-theme') || 'dark';
        applyTheme(current === 'dark' ? 'light' : 'dark');
      });
    }
  }

  function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    try { localStorage.setItem('hig-theme', theme); } catch (_) { /* ignore */ }
    const icon = document.querySelector('#theme-toggle .theme-toggle-icon');
    // Wir zeigen das Symbol, zu dem geklickt würde: im Dark-Mode die Sonne
    // (→ Light), im Light-Mode den Mond (→ Dark).
    if (icon) icon.textContent = theme === 'light' ? '☾' : '☀';
  }

  async function boot() {
    const urlInfo = resolveUrlCondition();
    const participantId = resolveParticipantId();
    const timeLimitMs = resolveTimeLimitMs();

    // Sequenzen früh laden — wenn das fehlschlägt, hat der Welcome-Screen
    // keinen Sinn (Start-Button würde später ins Leere greifen).
    let sequences;
    try {
      sequences = await window.sequencesModule.loadSequences();
    } catch (err) {
      console.error(err);
      showError(
        'Could not load the tasks. ' +
        'Please start the page via the local server (`python server.py`) ' +
        'and then open http://localhost:8000.'
      );
      return;
    }

    const testMode = resolveTestMode();
    bindConsentScreen({ participantId, urlInfo, sequences, timeLimitMs, testMode });
    bindTrialScreen();
    bindPhaseIntroScreen();
    bindInstructionsScreen();
    bindQuizScreen();
    bindSurveyScreen();
    bindEndScreen();

    // hints.init wird beim Klick auf den Consent-Button aufgerufen, sobald
    // die Condition vom Server (oder URL-Param) bekannt ist.

    // Engine bekommt UI-Callbacks — der Engine-Code selbst kennt kein DOM.
    window.experiment.setCallbacks({
      showPhaseIntro:      showPhaseIntro,
      showTrial:           showTrial,
      showInstructions:    showInstructions,
      showSurvey:          showSurvey,
      showEnd:             showEnd,
      showFeedback:        showFeedback,
      clearFeedback:       clearFeedback,
      updateTimer:         updateTimer,
      updateScore:         updateScore,
      setSkipVisible:      setSkipVisible,
      setPracticeBanner:   setPracticeBanner,
      setInputEnabled:     setInputEnabled,
      setHintArrowVisible: setHintArrowVisible,
      setHintGlow:         setHintGlow,
      setSpeechBubble:     setSpeechBubble,
      setProgressVisible:  setProgressVisible,
      updateProgress:      updateProgress,
      getScratchpadText:   getScratchpadText,
      resetInput:          resetTrialInput
    });

    // Erster Screen ist der Consent.
    showScreen('consent');
  }

  // ---------- Consent ---------------------------------------------------

  function bindConsentScreen({ participantId, urlInfo, sequences, timeLimitMs, testMode }) {
    const btn = $('consent-btn');
    let starting = false;
    btn.addEventListener('click', async () => {
      if (starting) return;
      starting = true;
      // Fullscreen-API darf nur in einem User-Gesture-Handler aufgerufen werden.
      requestFullscreen();

      // Condition holen: URL-Param > Server-Round-Robin > Random-Fallback.
      const { condition, conditionAssigned } = await resolveCondition(urlInfo);

      window.hints.init(condition, {
        lightbulbBtn:    $('hint-lightbulb-btn'),
        panelEl:         $('hint-panel'),
        closeBtn:        $('hint-close-btn'),
        messagesEl:      $('hint-messages'),
        followupForm:    $('hint-followup-form'),
        followupInput:   $('hint-followup-input'),
        errorEl:         $('hint-error'),
        // hints.js feuert das hier nach dem ersten Hint pro Trial — wir
        // reichen das weiter an die Engine, damit sie Pfeil + Input-Lock
        // aufhebt (relevant für forced-hint Practice-Trials).
        onHintDelivered: () => window.experiment.onHintReceived()
      });

      window.experiment.init({
        participantId,
        condition,
        conditionAssigned,
        sequences,
        timeLimitMs,
        testMode
      });
      window.experiment.start();
    });
  }

  /**
   * Liefert Hint-Bedingung + woher sie kommt.
   *   1) `?condition=...` aus der URL gewinnt immer.
   *   2) Sonst fragt das Frontend `/api/condition` — der Server zählt im
   *      Round-Robin durch (direct → strategy → reflective → control → …).
   *   3) Wenn der Server nicht erreichbar ist (z. B. statisches Hosting),
   *      Fallback auf eine zufällige Auswahl.
   */
  async function resolveCondition(urlInfo) {
    if (urlInfo && urlInfo.value) {
      return { condition: urlInfo.value, conditionAssigned: 'url' };
    }
    try {
      const resp = await fetch('/api/condition');
      if (resp.ok) {
        const data = await resp.json();
        if (data && VALID_CONDITIONS.includes(data.condition)) {
          return { condition: data.condition, conditionAssigned: 'auto' };
        }
      }
    } catch (err) {
      console.warn('Could not fetch condition from server, falling back to random:', err);
    }
    const cond = VALID_CONDITIONS[Math.floor(Math.random() * VALID_CONDITIONS.length)];
    return { condition: cond, conditionAssigned: 'random' };
  }

  // ---------- URL / Condition / Participant-ID --------------------------

  /**
   * Versuchspersonen-ID: bevorzugt aus ?id=... in der URL, sonst random.
   * Random-Format: p_XXXXXX, ohne verwechselbare Zeichen (kein 0/O/1/I).
   */
  function resolveParticipantId() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = (params.get('id') || '').trim();
    if (fromUrl) return fromUrl;

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let suffix = '';
    for (let i = 0; i < 6; i++) {
      suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    return 'p_' + suffix;
  }

  /**
   * `?testmode=1` aktiviert den Skip-Button auf jedem Trial. Praktisch zum
   * Durchklicken — wird im CSV als `test_mode=true` markiert.
   */
  function resolveTestMode() {
    const params = new URLSearchParams(window.location.search);
    return params.get('testmode') === '1';
  }

  /**
   * Test-Modus: `?timelimit=<Sekunden>` überschreibt das 2:30-Limit pro Aufgabe
   * (z.B. `?timelimit=40`), um Durchläufe schneller zu testen.
   * Ohne Parameter gilt der Default (150 s).
   * @returns {number|undefined} Limit in Millisekunden oder undefined
   */
  function resolveTimeLimitMs() {
    const params = new URLSearchParams(window.location.search);
    const raw = (params.get('timelimit') || '').trim();
    if (!raw) return undefined;
    const sec = Number(raw);
    if (!Number.isFinite(sec) || sec <= 0) {
      console.warn(`Ungültiges ?timelimit='${raw}', ignoriere.`);
      return undefined;
    }
    return Math.round(sec * 1000);
  }

  /**
   * Liest `?condition=...` aus der URL — falls gültig, wird der Wert
   * auf dem Welcome-Screen als Default-Auswahl im Radio-Picker gesetzt.
   * Die endgültige Condition wird beim Klick auf "Start" festgelegt.
   */
  function resolveUrlCondition() {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('condition');
    if (raw && VALID_CONDITIONS.includes(raw)) {
      return { value: raw, present: true };
    }
    if (raw) {
      console.warn(`Unbekannte Condition '${raw}', ignoriere URL-Parameter.`);
    }
    return { value: null, present: false };
  }

  function requestFullscreen() {
    const el = document.documentElement;
    const fn =
      el.requestFullscreen ||
      el.webkitRequestFullscreen ||
      el.mozRequestFullScreen ||
      el.msRequestFullscreen;
    if (fn) {
      try { fn.call(el); } catch (_) { /* User hat abgelehnt — nicht kritisch. */ }
    }
  }

  // ---------- Phase-Intro ----------------------------------------------

  function bindPhaseIntroScreen() {
    $('phase-intro-continue-btn').addEventListener('click', () => {
      window.experiment.continueFromPhaseIntro();
    });
  }

  function showPhaseIntro(_phase, intro) {
    $('phase-intro-title').textContent = intro.title;
    $('phase-intro-text').textContent = intro.text;
    showScreen('phaseIntro');
  }

  // ---------- Trial -----------------------------------------------------

  function bindTrialScreen() {
    $('trial-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const value = $('trial-answer-input').value;
      window.experiment.submitAnswer(value);
    });

    // Skip-Button: nur sichtbar, wenn Test-Modus auf der Startseite an war.
    $('trial-skip-btn').addEventListener('click', () => {
      window.experiment.skipCurrentTrial();
    });
  }

  function showTrial(trial, meta) {
    $('trial-sequence').textContent =
      window.sequencesModule.trialText(trial, '  —  ');
    if (meta && meta.counter) {
      $('trial-counter').textContent = `${meta.phaseLabel} · ${meta.counter}`;
    }
    // Scratchpad für jede Aufgabe leeren — verhindert Rückgriff auf
    // Notizen/Patterns vergangener Aufgaben.
    $('trial-notepad').value = '';
    showScreen('trial');
    $('trial-answer-input').focus();
  }

  function showFeedback(kind, message) {
    const el = $('trial-feedback');
    el.textContent = message;
    el.classList.remove('is-correct', 'is-wrong');
    el.classList.add(kind === 'correct' ? 'is-correct' : 'is-wrong');
    // Konfetti-Regen über dem Trial bei JEDER richtigen Antwort —
    // auch in Practice, wo es keine Punkte gibt.
    if (kind === 'correct') spawnConfetti(28);
  }

  function clearFeedback() {
    const el = $('trial-feedback');
    el.textContent = '';
    el.classList.remove('is-correct', 'is-wrong');
  }

  function updateTimer(remainingMs) {
    const el = $('trial-timer');
    if (remainingMs === null || remainingMs === undefined) {
      // Practice (kein Timer) — neutral anzeigen, ohne Warn-Highlight.
      el.textContent = '--:--';
      el.classList.remove('is-low');
      return;
    }
    const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
    const mm = Math.floor(totalSec / 60);
    const ss = String(totalSec % 60).padStart(2, '0');
    el.textContent = `${mm}:${ss}`;
    el.classList.toggle('is-low', totalSec <= 30);
  }

  function setPracticeBanner(text) {
    const el = $('trial-practice-banner');
    if (text) {
      el.textContent = text;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  function setInputEnabled(enabled) {
    const input = $('trial-answer-input');
    input.disabled = !enabled;
    if (enabled) {
      input.placeholder = '';
      // Im aktiven Trial-Screen sofort Fokus reingeben — komfortabel, sobald
      // das Eingabefeld nach Hint-Lock freigeschaltet wird.
      input.focus();
    } else {
      input.placeholder = 'Click the lightbulb first…';
    }
  }

  function setHintArrowVisible(visible) {
    $('hint-arrow').hidden = !visible;
  }

  function updateScore(totalScore, delta) {
    const el = $('trial-score');
    el.textContent = `${totalScore} pts`;
    if (delta && delta > 0) {
      // Score-Pulse-Animation neu antriggern (durch class-remove → reflow → add).
      el.classList.remove('is-pulsing');
      void el.offsetWidth;
      el.classList.add('is-pulsing');
      // Schwebendes "+N" über der Statusleiste.
      showScoreFloat(delta);
    }
  }

  function showScoreFloat(delta) {
    const status = document.querySelector('.trial-status');
    if (!status) return;
    const float = document.createElement('span');
    float.className = 'score-float';
    float.textContent = `+${delta}`;
    // Über der Score-Position rechts platzieren.
    float.style.right = '5rem';
    float.style.top = '0.4rem';
    status.appendChild(float);
    setTimeout(() => float.remove(), 1100);
  }

  function setHintGlow(active) {
    const btn = $('hint-lightbulb-btn');
    btn.classList.toggle('is-glowing', !!active);
  }

  function setSpeechBubble(text) {
    const el = $('hint-speech-bubble');
    if (text) {
      el.textContent = text;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  function setProgressVisible(visible) {
    $('progress-bar').hidden = !visible;
  }

  function updateProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    $('progress-fill').style.width = `${pct}%`;
  }

  function getScratchpadText() {
    return $('trial-notepad').value;
  }

  function setSkipVisible(visible) {
    $('trial-skip-btn').hidden = !visible;
  }

  function resetTrialInput() {
    const input = $('trial-answer-input');
    input.value = '';
    input.focus();
  }

  // ---------- Instructions + Quiz --------------------------------------

  function bindInstructionsScreen() {
    $('instructions-continue-btn').addEventListener('click', () => {
      // Vor jedem Quiz-Aufruf: alte Auswahl beibehalten ist OK, aber Retry-
      // Hinweis ausblenden (wird vom showInstructions-Callback gesetzt).
      showScreen('quiz');
    });
  }

  /** Aus experiment.js gerufen, nachdem alle Practice-Trials durch sind
   *  und bei jedem Quiz-Failure erneut. */
  function showInstructions(retry) {
    $('instructions-retry-note').hidden = !retry;
    showScreen('instructions');
  }

  function bindQuizScreen() {
    $('quiz-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      let allCorrect = true;
      for (const name of Object.keys(QUIZ_ANSWERS)) {
        const selected = document.querySelector(`input[name="${name}"]:checked`);
        if (!selected || selected.value !== QUIZ_ANSWERS[name]) {
          allCorrect = false;
          break;
        }
      }
      if (allCorrect) {
        // Quiz bestanden → Baseline-Intro anzeigen.
        window.experiment.startMainFromInstructions();
      } else {
        // Falsch → zurück zu Instructions mit Retry-Hinweis. Antworten
        // bleiben stehen, damit der Teilnehmer korrigieren kann.
        showInstructions(true);
      }
    });
  }

  // ---------- Survey ----------------------------------------------------

  function bindSurveyScreen() {
    $('survey-form').addEventListener('submit', (ev) => {
      ev.preventDefault();

      const backgroundEl = document.querySelector('input[name="survey-background"]:checked');

      const survey = {
        distraction:       $('survey-distraction').value.trim(),
        background:        backgroundEl ? backgroundEl.value : '',
        background_detail: $('survey-background-detail').value.trim()
      };

      // Logger merkt sich die Survey-Antworten für den SURVEY-Block der CSV.
      window.logger.setSurvey(survey);

      // Jetzt zum End-Screen — der speichert die CSV auch automatisch
      // serverseitig (inkl. der Survey-Daten).
      showEnd(pendingSummary);
    });
  }

  function showSurvey(summary) {
    pendingSummary = summary;
    showScreen('survey');
  }

  // ---------- End -------------------------------------------------------

  function bindEndScreen() {
    $('end-download-btn').addEventListener('click', () => {
      const { participantId, condition } = window.experiment.getState();
      window.logger.downloadCsv(participantId, condition);
    });
  }

  function showEnd(summary) {
    const { participantId, condition } = window.experiment.getState();
    $('end-participant-id').textContent = participantId;

    const scoreEl = $('end-score');
    const total = summary ? Number(summary.total_points) || 0 : 0;
    scoreEl.textContent = `Final score: 0 points`;

    // Per-Phase-Aufschlüsselung unter dem Hauptscore.
    const breakdownEl = document.getElementById('end-score-breakdown');
    if (summary && summary.scoresByPhase && breakdownEl) {
      const by = summary.scoresByPhase;
      breakdownEl.innerHTML =
        `<span>Baseline: <strong>${by.baseline || 0}</strong></span>` +
        `<span>Training: <strong>${by.training || 0}</strong></span>` +
        `<span>Test: <strong>${by.test || 0}</strong></span>`;
    }

    showScreen('end');

    // Score von 0 hochzählen (~1 s) und dezente Konfetti-Animation.
    animateScoreCountUp(scoreEl, total, 1100);
    spawnConfetti(28);

    // Daten automatisch auf dem Host-Laptop speichern (LAN-tauglich).
    saveResultsToHost(participantId, condition);
  }

  function animateScoreCountUp(el, target, durationMs) {
    if (target <= 0) {
      el.textContent = `Final score: 0 points`;
      return;
    }
    const startTs = performance.now();
    function step(ts) {
      const t = Math.min(1, (ts - startTs) / durationMs);
      // ease-out
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(target * eased);
      el.textContent = `Final score: ${value} points`;
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function spawnConfetti(count) {
    const layer = document.createElement('div');
    layer.className = 'confetti';
    const palette = ['#5fa8d3', '#7bc97b', '#e07b7b', '#e8e8e8', '#a0a0a0'];
    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      p.className = 'confetti-particle';
      const left = (Math.random() * 100).toFixed(1) + 'vw';
      const drift = (Math.random() * 200 - 100).toFixed(0) + 'px';
      const rot = Math.round(Math.random() * 360);
      const dur = 1700 + Math.round(Math.random() * 1600);
      const delay = Math.round(Math.random() * 600);
      p.style.left = left;
      p.style.setProperty('--drift', drift);
      p.style.setProperty('--rot', rot + 'deg');
      p.style.setProperty('--dur', dur + 'ms');
      p.style.setProperty('--delay', delay + 'ms');
      p.style.background = palette[i % palette.length];
      layer.appendChild(p);
    }
    document.body.appendChild(layer);
    // Nach ~4 s wieder aufräumen.
    setTimeout(() => layer.remove(), 4200);
  }

  /**
   * Schickt die CSV an den Server, der sie auf dem Host-Rechner ablegt.
   * So landet die Datei auch dann beim Versuchsleiter, wenn ein Teilnehmer
   * das Experiment über die LAN-IP auf einem anderen Gerät spielt.
   */
  async function saveResultsToHost(participantId, condition) {
    try {
      const resp = await fetch('/api/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participant_id: participantId,
          condition: condition,
          csv: window.logger.buildCsv()
        })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      // Nicht kritisch: der manuelle Download-Button bleibt als Fallback.
      console.error('Could not auto-save results to host:', err);
    }
  }

  // ---------- Screen-Routing -------------------------------------------

  function showScreen(name) {
    for (const key of Object.keys(screens)) {
      const el = screens[key]();
      if (el) el.hidden = key !== name;
    }
  }

  function showError(message) {
    $('error-message').textContent = message;
    showScreen('error');
  }
})();
