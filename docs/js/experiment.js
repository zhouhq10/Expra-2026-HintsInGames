/**
 * experiment.js
 *
 * Kern-State und Trial-Engine. Verwaltet:
 *   - das zentrale experimentState-Objekt (Single Source of Truth)
 *   - den Phasen-Flow (baseline -> training -> test -> end)
 *   - eine Trial-Instanz (Sequenz anzeigen, Antworten verarbeiten, Skip)
 *
 * Iteration 1: Hint-Logik existiert noch nicht — alle Probanden laufen
 * faktisch wie im Control-Modus. Logger-Felder für Hints werden mit
 * 'none'/false vorbefüllt.
 *
 * Hängt globales Objekt `experiment` an `window`.
 */
(function () {
  'use strict';

  const CORRECT_FEEDBACK_MS = 1500;     // Auto-Advance-Delay nach richtiger Antwort
  const DEFAULT_TIME_LIMIT_MS = 150000; // 2:30 Zeitlimit pro Aufgabe (Default)
  const COMPLETION_POINTS = 100;        // Fixpunkte fürs Lösen
  const MAX_TIME_BONUS = 150;           // Zeitbonus = max(0, MAX_TIME_BONUS - Sekunden)

  // Phase-transition copy. One place, easy to edit.
  const PHASE_INTROS = {
    baseline: {
      title: 'Phase 1 of 3: Warm-up',
      text:
        'You will see several number sequences without any help. ' +
        'Find the missing number marked "?". You have 2:30 per task — ' +
        'a correct answer scores 100 points plus a bonus for solving quickly.'
    },
    training: {
      title: 'Phase 2 of 3: Training',
      text:
        'In this phase you may request hints if you need them. ' +
        'The same 2:30 time limit and scoring apply to every task.'
    },
    test: {
      title: 'Phase 3 of 3: Test',
      text:
        'In the final section you solve without hints again. ' +
        'Same rules: 2:30 per task, points for speed. Do your best.'
    }
  };

  const PHASE_LABELS = {
    baseline: 'Warm-up phase',
    training: 'Training phase',
    test: 'Test phase'
  };

  // Reihenfolge der Phasen.
  const PHASE_ORDER = ['baseline', 'training', 'test'];

  // Single source of truth — kein verstreuter globaler State.
  const experimentState = {
    participantId: null,
    condition: null,
    conditionAssigned: null, // 'url' | 'random'
    sequences: { baseline: [], training: [], test: [] },
    currentPhaseIdx: 0,      // index in PHASE_ORDER
    currentTrialIdx: 0,
    currentTrialState: null,
    timeLimitMs: DEFAULT_TIME_LIMIT_MS, // pro Aufgabe; per ?timelimit= überschreibbar
    testMode: false,         // Test-Modus: Skip-Button im Trial-Screen einblenden
    totalScore: 0,           // kumulative Punkte über alle Trials
    log: []                  // referenziert die Records des Loggers (informativ)
  };

  // Callbacks, die main.js setzt — entkoppelt UI-Routing von Engine-Logik.
  const callbacks = {
    showPhaseIntro: null, // (phase, intro) => void
    showTrial: null,      // (trial, meta) => void
    showEnd: null,        // (summary) => void
    showFeedback: null,   // (kind: 'correct'|'wrong', msg: string) => void
    clearFeedback: null,  // () => void
    updateTimer: null,    // (remainingMs: number) => void
    updateScore: null,    // (totalScore: number) => void
    setSkipVisible: null, // (visible: boolean) => void  — Skip-Button im Test-Modus
    resetInput: null      // () => void
  };

  // ---------- Public API -------------------------------------------------

  /** Initialisiert den State nach erfolgreichem Welcome-Submit. */
  function init({ participantId, condition, conditionAssigned, sequences, timeLimitMs, testMode }) {
    experimentState.participantId = participantId;
    experimentState.condition = condition;
    experimentState.conditionAssigned = conditionAssigned;
    experimentState.sequences = sequences;
    experimentState.currentPhaseIdx = 0;
    experimentState.currentTrialIdx = 0;
    experimentState.currentTrialState = null;
    experimentState.timeLimitMs =
      Number.isFinite(timeLimitMs) && timeLimitMs > 0
        ? timeLimitMs
        : DEFAULT_TIME_LIMIT_MS;
    experimentState.testMode = !!testMode;
    experimentState.totalScore = 0;
  }

  function setCallbacks(cbs) {
    Object.assign(callbacks, cbs);
  }

  /** Startet die erste Phase mit Intro-Screen. */
  function start() {
    showPhaseIntro();
  }

  /** Wird aus main.js gerufen, wenn der Phase-Intro-Weiter-Button geklickt wird. */
  function continueFromPhaseIntro() {
    startCurrentTrial();
  }

  /**
   * Verarbeitet eine eingereichte Antwort.
   * @param {string} rawValue - Roh-String aus dem Eingabefeld.
   */
  function submitAnswer(rawValue) {
    const trialState = experimentState.currentTrialState;
    if (!trialState) return;

    const parsed = parseAnswer(rawValue);
    trialState.numAttempts += 1;

    if (parsed === null) {
      // Invalid input (empty / non-numeric). We don't log it as a
      // wrongAttempt — otherwise pressing Enter on an empty field would
      // drive up the skip counter for no real reason.
      callbacks.showFeedback('wrong', 'Please enter a number.');
      trialState.numAttempts -= 1; // input wasn't a real submission, revert
      return;
    }

    const trial = currentTrial();
    const isCorrect = parsed === trial.answer;

    if (isCorrect) {
      stopTimer();
      const points = finalizeTrial({
        participantAnswer: String(parsed),
        isCorrect: true,
        wasSkipped: false,
        timedOut: false
      });
      callbacks.showFeedback('correct', `Correct!  +${points.points_total} points`);
      setTimeout(() => {
        callbacks.clearFeedback();
        advanceTrial();
      }, CORRECT_FEEDBACK_MS);
      return;
    }

    // Falsche Antwort: weitermachen lassen, bis die Zeit abläuft.
    trialState.numWrongAttempts += 1;
    trialState.lastAnswer = String(parsed);
    callbacks.showFeedback('wrong', "That's not correct — try again.");
    callbacks.resetInput();
  }

  /**
   * Manueller Skip — nur im Test-Modus über den Skip-Button erreichbar.
   * Wird wie ein nicht-gelöster Trial gewertet (0 Punkte, was_skipped=true).
   */
  function skipCurrentTrial() {
    const trialState = experimentState.currentTrialState;
    if (!trialState) return;

    stopTimer();
    finalizeTrial({
      participantAnswer: trialState.lastAnswer || '',
      isCorrect: false,
      wasSkipped: true,
      timedOut: false
    });
    callbacks.clearFeedback();
    advanceTrial();
  }

  /** Wird gerufen, wenn das Zeitlimit der aktuellen Aufgabe abläuft. */
  function timeoutCurrentTrial() {
    const trialState = experimentState.currentTrialState;
    if (!trialState) return;

    stopTimer();
    finalizeTrial({
      participantAnswer: trialState.lastAnswer || '',
      isCorrect: false,
      wasSkipped: false,
      timedOut: true
    });
    callbacks.showFeedback('wrong', "Time's up!");
    setTimeout(() => {
      callbacks.clearFeedback();
      advanceTrial();
    }, CORRECT_FEEDBACK_MS);
  }

  // ---------- Internals --------------------------------------------------

  function stopTimer() {
    const ts = experimentState.currentTrialState;
    if (ts && ts.timerHandle) {
      clearInterval(ts.timerHandle);
      ts.timerHandle = null;
    }
  }

  function currentPhase() {
    return PHASE_ORDER[experimentState.currentPhaseIdx];
  }

  function currentTrial() {
    const phase = currentPhase();
    return experimentState.sequences[phase][experimentState.currentTrialIdx];
  }

  function showPhaseIntro() {
    const phase = currentPhase();
    callbacks.showPhaseIntro(phase, PHASE_INTROS[phase]);
  }

  function startCurrentTrial() {
    const trial = currentTrial();
    if (!trial) {
      // Keine Sequenzen für diese Phase — überspringen.
      advancePhase();
      return;
    }

    const startTs = performance.now();
    experimentState.currentTrialState = {
      startTs: startTs,
      deadlineTs: startTs + experimentState.timeLimitMs,
      timerHandle: null,
      numAttempts: 0,
      numWrongAttempts: 0,
      lastAnswer: ''
    };

    callbacks.clearFeedback();
    callbacks.resetInput();
    // Skip-Button nur im Test-Modus zeigen.
    if (callbacks.setSkipVisible) callbacks.setSkipVisible(experimentState.testMode);

    // hints.js verwaltet seinen eigenen Per-Trial-State (used / trigger / time).
    if (window.hints) {
      window.hints.onTrialStart(trial);
    }

    const phase = currentPhase();
    const total = experimentState.sequences[phase].length;
    callbacks.showTrial(trial, {
      phaseLabel: PHASE_LABELS[phase],
      counter: `Task ${experimentState.currentTrialIdx + 1} of ${total}`
    });
    if (callbacks.updateScore) callbacks.updateScore(experimentState.totalScore);

    // Countdown starten: jede Sekunde aktualisieren, bei 0 -> Timeout.
    startTimer();
  }

  function startTimer() {
    const ts = experimentState.currentTrialState;
    const tick = () => {
      const remaining = ts.deadlineTs - performance.now();
      if (remaining <= 0) {
        if (callbacks.updateTimer) callbacks.updateTimer(0);
        timeoutCurrentTrial();
        return;
      }
      if (callbacks.updateTimer) callbacks.updateTimer(remaining);
    };
    tick(); // sofort einmal rendern, nicht erst nach 1 s
    ts.timerHandle = setInterval(tick, 250);
  }

  /**
   * Schreibt einen Log-Record für den aktuellen Trial.
   * Wird sowohl bei richtiger Antwort als auch beim Skip aufgerufen.
   */
  function finalizeTrial({ participantAnswer, isCorrect, wasSkipped, timedOut }) {
    const trial = currentTrial();
    const trialState = experimentState.currentTrialState;
    // Lösungszeit auf das Zeitlimit deckeln (z.B. bei Timeout exakt 150000).
    const solvingTimeMs = Math.min(
      Math.round(performance.now() - trialState.startTs),
      experimentState.timeLimitMs
    );

    // Punkte: 100 fürs Lösen + linearer Zeitbonus, beides nur bei korrekt.
    const pointsCompletion = isCorrect ? COMPLETION_POINTS : 0;
    const pointsTimeBonus = isCorrect
      ? Math.max(0, MAX_TIME_BONUS - Math.ceil(solvingTimeMs / 1000))
      : 0;
    const pointsTotal = pointsCompletion + pointsTimeBonus;
    experimentState.totalScore += pointsTotal;
    if (callbacks.updateScore) callbacks.updateScore(experimentState.totalScore);

    const hintData = window.hints
      ? window.hints.getTrialHintData()
      : {
          hint_used: false,
          hint_trigger: 'none',
          time_to_first_hint_ms: '',
          hint_count: 0,
          hint_texts: '',
          llm_model: ''
        };

    window.logger.logTrial({
      participant_id: experimentState.participantId,
      condition: experimentState.condition,
      condition_assigned: experimentState.conditionAssigned,
      phase: trial.phase,
      trial_id: trial.id,
      sequence: window.sequencesModule.trialText(trial, ','),
      correct_answer: trial.answer,
      participant_answer: participantAnswer,
      is_correct: isCorrect,
      was_skipped: wasSkipped,
      timed_out: !!timedOut,
      test_mode: experimentState.testMode,
      is_bottleneck: !!trial.is_bottleneck,
      solving_time_ms: solvingTimeMs,
      num_attempts: trialState.numAttempts,
      num_wrong_attempts: trialState.numWrongAttempts,
      points_completion: pointsCompletion,
      points_time_bonus: pointsTimeBonus,
      points_total: pointsTotal,
      hint_used: hintData.hint_used,
      hint_trigger: hintData.hint_trigger,
      time_to_first_hint_ms: hintData.time_to_first_hint_ms,
      hint_count: hintData.hint_count,
      hint_texts: hintData.hint_texts,
      llm_model: hintData.llm_model,
      timestamp: new Date().toISOString()
    });

    if (window.hints) {
      window.hints.onTrialEnd();
    }

    return { points_completion: pointsCompletion, points_time_bonus: pointsTimeBonus, points_total: pointsTotal };
  }

  function advanceTrial() {
    stopTimer(); // doppelt hält besser — kein verwaister Interval
    experimentState.currentTrialIdx += 1;

    const phase = currentPhase();
    const remaining = experimentState.sequences[phase].length;

    if (experimentState.currentTrialIdx < remaining) {
      startCurrentTrial();
    } else {
      advancePhase();
    }
  }

  function advancePhase() {
    experimentState.currentPhaseIdx += 1;
    experimentState.currentTrialIdx = 0;

    if (experimentState.currentPhaseIdx >= PHASE_ORDER.length) {
      callbacks.showEnd(window.logger.getSummary());
      return;
    }
    showPhaseIntro();
  }

  /**
   * Akzeptiert ganze Zahlen (mit optionalem Minuszeichen).
   * Lehnt Dezimalzahlen, leere und nicht-numerische Eingaben ab.
   * @returns {number | null}
   */
  function parseAnswer(raw) {
    const trimmed = (raw || '').trim();
    if (trimmed === '') return null;
    if (!/^-?\d+$/.test(trimmed)) return null;
    return parseInt(trimmed, 10);
  }

  // Read-only Zugang für main.js (z.B. für CSV-Download-Filename).
  function getState() {
    return {
      participantId: experimentState.participantId,
      condition: experimentState.condition
    };
  }

  window.experiment = {
    init,
    setCallbacks,
    start,
    continueFromPhaseIntro,
    submitAnswer,
    skipCurrentTrial,
    getState
  };
})();
