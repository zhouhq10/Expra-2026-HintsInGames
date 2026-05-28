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
    welcome:    () => $('screen-welcome'),
    phaseIntro: () => $('screen-phase-intro'),
    trial:      () => $('screen-trial'),
    end:        () => $('screen-end'),
    error:      () => $('screen-error')
  };

  // Beim DOMContentLoaded los.
  document.addEventListener('DOMContentLoaded', boot);

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

    bindWelcomeScreen({ participantId, urlInfo, sequences, timeLimitMs });
    bindTrialScreen();
    bindPhaseIntroScreen();
    bindEndScreen();

    // hints.init wird beim Klick auf "Experiment starten" aufgerufen,
    // weil wir die endgültige Condition erst dann kennen (Radio-Button).

    // Engine bekommt UI-Callbacks — der Engine-Code selbst kennt kein DOM.
    window.experiment.setCallbacks({
      showPhaseIntro: showPhaseIntro,
      showTrial:      showTrial,
      showEnd:        showEnd,
      showFeedback:   showFeedback,
      clearFeedback:  clearFeedback,
      updateTimer:    updateTimer,
      updateScore:    updateScore,
      setSkipVisible: setSkipVisible,
      resetInput:     resetTrialInput
    });

    showScreen('welcome');
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

  /**
   * Liest die aktuelle Condition-Auswahl im Welcome-Screen-Radio-Picker.
   * Gibt Endwert + Quell-Info zurück (für CSV-Logging).
   */
  function readSelectedCondition(urlInfo) {
    const selected = document.querySelector('input[name="welcome-condition"]:checked');
    const choice = selected ? selected.value : 'random';

    if (choice === 'random') {
      const cond = VALID_CONDITIONS[Math.floor(Math.random() * VALID_CONDITIONS.length)];
      return { condition: cond, conditionAssigned: 'random' };
    }
    // Konkrete Auswahl: 'url' wenn der Wert vom URL-Parameter kam und
    // unverändert blieb; sonst 'manual' (per Welcome-Screen ausgewählt).
    const assigned = (urlInfo.present && urlInfo.value === choice) ? 'url' : 'manual';
    return { condition: choice, conditionAssigned: assigned };
  }

  // ---------- Welcome ---------------------------------------------------

  function bindWelcomeScreen({ participantId, urlInfo, sequences, timeLimitMs }) {
    // URL-Parameter setzt den Default-Radio (falls gültig).
    if (urlInfo.value) {
      const radio = document.querySelector(
        `input[name="welcome-condition"][value="${urlInfo.value}"]`
      );
      if (radio) radio.checked = true;
    }

    $('welcome-start-btn').addEventListener('click', () => {
      // Fullscreen-API darf nur in einem User-Gesture-Handler aufgerufen werden.
      requestFullscreen();

      const { condition, conditionAssigned } = readSelectedCondition(urlInfo);

      // Hints-Modul jetzt initialisieren — wir kennen erst hier die
      // endgültige Condition.
      window.hints.init(condition, {
        lightbulbBtn:  $('hint-lightbulb-btn'),
        panelEl:       $('hint-panel'),
        closeBtn:      $('hint-close-btn'),
        messagesEl:    $('hint-messages'),
        followupForm:  $('hint-followup-form'),
        followupInput: $('hint-followup-input'),
        errorEl:       $('hint-error')
      });

      const testMode = $('welcome-test-mode').checked;

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
  }

  function clearFeedback() {
    const el = $('trial-feedback');
    el.textContent = '';
    el.classList.remove('is-correct', 'is-wrong');
  }

  function updateTimer(remainingMs) {
    const el = $('trial-timer');
    const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
    const mm = Math.floor(totalSec / 60);
    const ss = String(totalSec % 60).padStart(2, '0');
    el.textContent = `${mm}:${ss}`;
    el.classList.toggle('is-low', totalSec <= 30);
  }

  function updateScore(totalScore) {
    $('trial-score').textContent = `${totalScore} pts`;
  }

  function setSkipVisible(visible) {
    $('trial-skip-btn').hidden = !visible;
  }

  function resetTrialInput() {
    const input = $('trial-answer-input');
    input.value = '';
    input.focus();
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

    if (summary) {
      const meanSec = Math.round((summary.mean_solving_time_ms || 0) / 1000);
      $('end-score').textContent =
        `Final score: ${summary.total_points} points  ·  ` +
        `${summary.num_correct}/${summary.num_tasks} solved  ·  ` +
        `avg ${meanSec}s per task`;
    }

    // Daten automatisch auf dem Host-Laptop speichern (LAN-tauglich).
    saveResultsToHost(participantId, condition);

    showScreen('end');
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
