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

  const CORRECT_FEEDBACK_MS = 1500;        // Auto-Advance-Delay nach richtiger Antwort
  const DEFAULT_TIME_LIMIT_MS = 150000;    // Fallback (Training), wenn Phase kein Mapping hat
  const COMPLETION_POINTS = 100;           // Fixpunkte fürs Lösen
  const WRONG_PENALTY = 10;                // Punktabzug pro Fehlversuch
  const MAX_WRONG_ATTEMPTS = 5;            // Nach so vielen Fehlern → Aufgabe übersprungen
  const WRONG_WARNING_AT = 3;              // Nach so vielen Fehlern → "2 attempts left" Hinweis

  // Phasen-Timer: Practice ohne, Baseline + Test 2:30, Training 3:00
  // (mehr Zeit, weil dort die LLM-Hint-Konversation reinpasst).
  const PHASE_TIME_LIMITS_MS = {
    practice: null,
    baseline: 150000,
    training: 180000,
    test:     150000
  };

  // Bruchteile des Trial-Timers, an denen die Training-Hint-Suggestion bzw.
  // -Enforcement losgeht. 60/180 = 1/3 und 90/180 = 1/2 (so bleibt der
  // ?timelimit=-Override beim Testen sinnvoll skaliert).
  const HINT_GLOW_AT_FRACTION = 1 / 3;
  const HINT_ENFORCE_AT_FRACTION = 1 / 2;

  // Phase-transition copy. One place, easy to edit.
  const PHASE_INTROS = {
    practice: {
      title: 'Practice (not counted)',
      text:
        'Three quick tasks to learn the interface. Take your time — ' +
        'there is no time limit here, and these tasks do not count toward your score.'
    },
    baseline: {
      title: 'Phase 1 of 3: Baseline',
      text:
        'You will see several number sequences without any help. ' +
        'Find the missing number marked "?". You have 2:30 per task — ' +
        'a correct answer scores 100 points plus a bonus for solving quickly. ' +
        'These questions are meant to be hard — don\'t get discouraged if you can\'t solve them all.'
    },
    training: {
      title: 'Phase 2 of 3: Training',
      text:
        'In this phase you may request hints from the AI helper. ' +
        'You have 3:00 per task — a little extra time so you can read the hint. ' +
        'Points and bonus work the same way.'
    },
    test: {
      title: 'Phase 3 of 3: Test',
      text:
        'In the final section you solve without hints again. ' +
        'You have 2:30 per task. Do your best.'
    }
  };

  const PHASE_LABELS = {
    practice: 'Practice',
    baseline: 'Baseline phase',
    training: 'Training phase',
    test: 'Test phase'
  };

  // Reihenfolge der Phasen. Practice steht vorn, zählt aber nicht für die
  // Punkte/Statistik. Zwischen Practice und Baseline schaltet sich
  // Instructions + Quiz dazwischen (vom main.js gesteuert).
  const PHASE_ORDER = ['practice', 'baseline', 'training', 'test'];

  // Single source of truth — kein verstreuter globaler State.
  const experimentState = {
    participantId: null,
    condition: null,
    conditionAssigned: null, // 'url' | 'random'
    sequences: { practice: [], baseline: [], training: [], test: [] },
    currentPhaseIdx: 0,      // index in PHASE_ORDER
    currentTrialIdx: 0,
    currentTrialState: null,
    timeLimitOverrideMs: null, // optionaler Override aus ?timelimit=...
    testMode: false,         // Test-Modus: Skip-Button im Trial-Screen einblenden
    quizPassed: false,       // Gating: erst nach Quiz-Pass startet die Baseline
    totalScore: 0,           // kumulative Punkte über alle Trials
    scoresByPhase: { baseline: 0, training: 0, test: 0 },
    mainTrialsCompleted: 0,  // Zähler für die Progress-Bar (nur Hauptphasen)
    totalMainTrials: 0,      // wird in init() aus den Sequenzen errechnet
    log: []                  // referenziert die Records des Loggers (informativ)
  };

  // Callbacks, die main.js setzt — entkoppelt UI-Routing von Engine-Logik.
  const callbacks = {
    showPhaseIntro: null,        // (phase, intro) => void
    showTrial: null,             // (trial, meta) => void
    showInstructions: null,      // (retry: boolean) => void — nach Practice & bei Quiz-Fail
    showSurvey: null,            // (summary) => void  — nach der letzten Phase, vor dem End-Screen
    showEnd: null,               // (summary) => void
    showFeedback: null,          // (kind: 'correct'|'wrong', msg: string) => void
    clearFeedback: null,         // () => void
    updateTimer: null,           // (remainingMs: number|null) => void
    updateScore: null,           // (totalScore: number) => void
    setSkipVisible: null,        // (visible: boolean) => void  — Skip-Button im Test-Modus
    setPracticeBanner: null,     // (text: string|null) => void — Practice-Banner setzen/verbergen
    setInputEnabled: null,       // (enabled: boolean) => void — Eingabe sperren in forced-hint Practice
    setHintArrowVisible: null,   // (visible: boolean) => void — Pfeil auf Glühbirne in forced-hint Practice
    setHintGlow: null,           // (active: boolean) => void — Glühbirne pulsen lassen (60s)
    setSpeechBubble: null,       // (text: string|null) => void — "Maybe you want to take a hint?"
    setProgressVisible: null,    // (visible: boolean) => void — Progress-Balken oben
    updateProgress: null,        // (done: number, total: number) => void
    getScratchpadText: null,     // () => string — Scratchpad-Inhalt fürs Logging
    resetInput: null             // () => void
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
    experimentState.timeLimitOverrideMs =
      Number.isFinite(timeLimitMs) && timeLimitMs > 0 ? timeLimitMs : null;
    experimentState.testMode = !!testMode;
    experimentState.quizPassed = false;
    experimentState.totalScore = 0;
    experimentState.scoresByPhase = { baseline: 0, training: 0, test: 0 };
    experimentState.mainTrialsCompleted = 0;
    experimentState.totalMainTrials =
      (sequences.baseline || []).length
      + (sequences.training || []).length
      + (sequences.test || []).length;

    // Practice-Filter je Bedingung:
    //   - Control: hat keine Glühbirne → forced-hint-Trials (prac_02/03)
    //     entfernen, dafür die Control-Ersatz-Trials (prac_04/05) behalten.
    //   - Andere Bedingungen: bekommen die normalen Hint-Trials, aber NICHT
    //     die einfacheren Control-only-Trials.
    const list = experimentState.sequences.practice || [];
    if (condition === 'control') {
      experimentState.sequences.practice = list.filter((t) => !t.requires_hint);
    } else {
      experimentState.sequences.practice = list.filter((t) => !t.control_only);
    }
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

    const trial = currentTrial();

    // Forced-Hint-Lock: Solange der Hint nicht abgerufen wurde, gehen
    // weder Antworten noch sonstige Eingaben durch.
    if (trial.requires_hint && !trialState.hintReceived) {
      callbacks.showFeedback('wrong', 'Please click the lightbulb first to see how hints work.');
      return;
    }

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

    const isCorrect = parsed === trial.answer;
    const isPractice = !!trial.is_practice;

    // Korrekt → Trial beenden, Punkte zeigen.
    // Practice + falsch → trotzdem weiter (kein Frustrations-Loop in der Übung).
    if (isCorrect || isPractice) {
      stopTimer();
      const points = finalizeTrial({
        participantAnswer: String(parsed),
        isCorrect: isCorrect,
        wasSkipped: false,
        timedOut: false
      });
      let msg;
      if (isCorrect) {
        msg = isPractice ? 'Correct!' : `Correct!  +${points.points_total} points`;
      } else {
        // Practice + falsch: kurzes, neutrales Feedback.
        msg = 'OK — moving on.';
      }
      callbacks.showFeedback(isCorrect ? 'correct' : 'wrong', msg);
      setTimeout(() => {
        callbacks.clearFeedback();
        advanceTrial();
      }, CORRECT_FEEDBACK_MS);
      return;
    }

    // Falsche Antwort in Haupt-Phasen.
    trialState.numWrongAttempts += 1;
    trialState.lastAnswer = String(parsed);
    const wrongs = trialState.numWrongAttempts;

    // 5-Trial-Skip: nach so vielen falschen Antworten wird die Aufgabe als
    // nicht-gelöst beendet und der nächste Trial gestartet.
    if (wrongs >= MAX_WRONG_ATTEMPTS) {
      stopTimer();
      finalizeTrial({
        participantAnswer: String(parsed),
        isCorrect: false,
        wasSkipped: false,
        timedOut: false
      });
      callbacks.showFeedback('wrong', `${MAX_WRONG_ATTEMPTS} attempts used — moving on.`);
      setTimeout(() => {
        callbacks.clearFeedback();
        advanceTrial();
      }, CORRECT_FEEDBACK_MS);
      return;
    }

    // 3-Versuche-Warnung (Hauptphasen): zusätzlicher Hinweis, dass nur noch
    // 2 Versuche bleiben, bevor die Aufgabe übersprungen wird.
    let feedback = "That's not correct — try again.";
    if (wrongs === WRONG_WARNING_AT) {
      const left = MAX_WRONG_ATTEMPTS - wrongs;
      feedback = `That's not correct — ${left} attempts left.`;
    }
    callbacks.showFeedback('wrong', feedback);
    callbacks.resetInput();

    // Training mit Hint-Bedingung: nach 3 Fehlern Hint zwangsweise einfordern.
    if (wrongs >= WRONG_WARNING_AT && isTrainingHintTrial(trial) && !trialState.hintReceived) {
      enforceHint();
    }
  }

  /**
   * Wird aus main.js gerufen, sobald der erste Hint eines Trials zugestellt
   * wurde. Schaltet die Antwort-Eingabe frei und blendet den Pfeil aus.
   */
  function onHintReceived() {
    const trialState = experimentState.currentTrialState;
    if (!trialState) return;
    if (trialState.hintReceived) return; // schon erledigt
    trialState.hintReceived = true;
    trialState.hintEnforced = false;
    // Komplette UI-Bereinigung: Eingabe wieder frei, Pfeil/Banner/Sprechblase/Glow weg.
    if (callbacks.setInputEnabled) callbacks.setInputEnabled(true);
    if (callbacks.setHintArrowVisible) callbacks.setHintArrowVisible(false);
    if (callbacks.setSpeechBubble) callbacks.setSpeechBubble(null);
    if (callbacks.setHintGlow) callbacks.setHintGlow(false);
    if (callbacks.setPracticeBanner) callbacks.setPracticeBanner(null);
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

  /** Liefert das Zeitlimit für eine Aufgabe.
   *  - Practice: kein Timer (null).
   *  - Sonst: Override aus URL-Param, sonst Phasen-Mapping, sonst Default. */
  function trialTimeLimitMs(trial) {
    if (trial.is_practice) return null;
    if (experimentState.timeLimitOverrideMs) return experimentState.timeLimitOverrideMs;
    return PHASE_TIME_LIMITS_MS[trial.phase] || DEFAULT_TIME_LIMIT_MS;
  }

  /** Eskaliert in Training: räumt die "soft suggestion"-UI (Glow + Sprechblase)
   *  weg und öffnet automatisch das Hint-Panel mit echter LLM-Anfrage —
   *  als hätte der Teilnehmer die Glühbirne selbst geklickt. Eingabefeld
   *  bleibt frei, kein Lock-Banner, kein Pfeil. */
  function enforceHint() {
    const ts = experimentState.currentTrialState;
    if (!ts || ts.hintEnforced || ts.hintReceived) return;
    ts.hintEnforced = true;
    if (callbacks.setSpeechBubble) callbacks.setSpeechBubble(null);
    if (callbacks.setHintGlow) callbacks.setHintGlow(false);
    if (window.hints && window.hints.autoTriggerHint) {
      window.hints.autoTriggerHint();
    }
  }

  /** Wahr, wenn der aktuelle Trial eine Trainings-Aufgabe mit Hint-Bedingung ist
   *  (also nicht control und nicht practice). Praxis-Forced-Hint läuft separat. */
  function isTrainingHintTrial(trial) {
    return trial
      && trial.phase === 'training'
      && !trial.is_practice
      && experimentState.condition !== 'control';
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

    const limitMs = trialTimeLimitMs(trial);
    const startTs = performance.now();
    experimentState.currentTrialState = {
      startTs: startTs,
      timeLimitMs: limitMs,                          // null in Practice
      deadlineTs: limitMs ? startTs + limitMs : null,
      timerHandle: null,
      numAttempts: 0,
      numWrongAttempts: 0,
      lastAnswer: '',
      hintReceived: false,
      hintGlowSet: false,    // 60%-Schwelle: Glow + Sprechblase
      hintEnforced: false    // 60%/90%-Schwelle ODER 3-Fehler: Forced-Hint-Mode
    };

    callbacks.clearFeedback();
    callbacks.resetInput();
    // Speech-Bubble + Glow am Trial-Anfang immer zurücksetzen.
    if (callbacks.setSpeechBubble) callbacks.setSpeechBubble(null);
    if (callbacks.setHintGlow) callbacks.setHintGlow(false);
    // Skip-Button nur im Test-Modus zeigen.
    if (callbacks.setSkipVisible) callbacks.setSkipVisible(experimentState.testMode);

    // Forced-Hint-Practice (prac_02 / prac_03): Eingabe sperren und Pfeil
    // zur Glühbirne einblenden, bis der erste Hint angefordert wurde.
    const forced = !!trial.requires_hint;
    if (callbacks.setInputEnabled) callbacks.setInputEnabled(!forced);
    if (callbacks.setHintArrowVisible) callbacks.setHintArrowVisible(forced);

    // Practice-Banner setzen (oder ausblenden, wenn nicht Practice).
    // Für `control` wird der Banner unterdrückt, weil die Standard-Texte
    // sich auf die Glühbirne beziehen — die Control-Probanden nie sehen.
    if (callbacks.setPracticeBanner) {
      const showBanner =
        trial.is_practice && experimentState.condition !== 'control';
      callbacks.setPracticeBanner(showBanner ? (trial.practice_banner || null) : null);
    }

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

    if (trial.is_practice) {
      // In Practice: kein Timer, kein Timeout. UI zeigt --:--.
      if (callbacks.updateTimer) callbacks.updateTimer(null);
    } else {
      // Countdown starten: jede Sekunde aktualisieren, bei 0 -> Timeout.
      startTimer();
    }
  }

  function startTimer() {
    const ts = experimentState.currentTrialState;
    const trial = currentTrial();
    const trainingHint = isTrainingHintTrial(trial);
    const glowAtMs    = ts.timeLimitMs * HINT_GLOW_AT_FRACTION;
    const enforceAtMs = ts.timeLimitMs * HINT_ENFORCE_AT_FRACTION;

    const tick = () => {
      const elapsed = performance.now() - ts.startTs;
      const remaining = ts.deadlineTs - performance.now();
      if (remaining <= 0) {
        if (callbacks.updateTimer) callbacks.updateTimer(0);
        timeoutCurrentTrial();
        return;
      }
      if (callbacks.updateTimer) callbacks.updateTimer(remaining);

      // Hint-Suggestion + Enforcement nur in Training mit Hint-Bedingung.
      if (trainingHint && !ts.hintReceived) {
        if (!ts.hintGlowSet && elapsed >= glowAtMs) {
          ts.hintGlowSet = true;
          if (callbacks.setHintGlow) callbacks.setHintGlow(true);
          if (callbacks.setSpeechBubble) callbacks.setSpeechBubble('Maybe you want to take a hint?');
        }
        if (!ts.hintEnforced && elapsed >= enforceAtMs) {
          enforceHint();
        }
      }
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
    const isPractice = !!trial.is_practice;
    // Lösungszeit messen — bei Hauptphasen auf das Zeitlimit deckeln, in
    // Practice nicht (dort gibt es keine harte Obergrenze).
    const elapsed = Math.round(performance.now() - trialState.startTs);
    const solvingTimeMs = (isPractice || !trialState.timeLimitMs)
      ? elapsed
      : Math.min(elapsed, trialState.timeLimitMs);

    // Punkte:
    //   completion = 100, nur bei korrekter Antwort in Hauptphasen.
    //   time bonus = max(0, time_limit_seconds - solving_seconds) — skaliert
    //                mit dem Phasen-Timer (Training 150, Baseline/Test 180).
    //   penalty = 10 × Fehlversuche.
    //   total = max(0, completion + bonus − penalty).
    const phaseLimitS = trialState.timeLimitMs
      ? Math.round(trialState.timeLimitMs / 1000)
      : 0;
    const pointsCompletion = (isCorrect && !isPractice) ? COMPLETION_POINTS : 0;
    const pointsTimeBonus = (isCorrect && !isPractice)
      ? Math.max(0, phaseLimitS - Math.ceil(solvingTimeMs / 1000))
      : 0;
    const wrongPenalty = (isCorrect && !isPractice)
      ? WRONG_PENALTY * trialState.numWrongAttempts
      : 0;
    const pointsTotal = Math.max(0, pointsCompletion + pointsTimeBonus - wrongPenalty);

    // Score-Pflege: gesamt + pro Phase. Practice zählt nicht.
    if (!isPractice) {
      experimentState.totalScore += pointsTotal;
      const phase = trial.phase;
      if (experimentState.scoresByPhase[phase] !== undefined) {
        experimentState.scoresByPhase[phase] += pointsTotal;
      }
      experimentState.mainTrialsCompleted += 1;
      if (callbacks.updateProgress) {
        callbacks.updateProgress(
          experimentState.mainTrialsCompleted,
          experimentState.totalMainTrials
        );
      }
    }
    if (callbacks.updateScore) callbacks.updateScore(experimentState.totalScore, pointsTotal);

    const hintData = window.hints
      ? window.hints.getTrialHintData()
      : {
          hint_used: false,
          hint_trigger: 'none',
          time_to_first_hint_ms: '',
          hint_count: 0,
          hint_texts: '',
          chat_history_json: '[]',
          llm_model: ''
        };

    // Scratchpad-Inhalt: über Callback aus main.js, damit experiment.js
    // weiter DOM-frei bleibt.
    const scratchpadText = callbacks.getScratchpadText
      ? (callbacks.getScratchpadText() || '')
      : '';

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
      is_practice: isPractice,
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
      chat_history_json: hintData.chat_history_json,
      scratchpad_text: scratchpadText,
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

    // Schutz gegen Doppel-Advance: ein verwaister setTimeout(advanceTrial)
    // (z.B. aus dem 5-Fehlversuche- oder Timeout-Pfad) kann feuern, nachdem
    // das Experiment bereits die letzte Phase verlassen hat. Dann gäbe es
    // keine aktuelle Phase mehr -> früher Absturz bei sequences[phase].length.
    const phase = currentPhase();
    if (!phase || !experimentState.sequences[phase]) return;

    experimentState.currentTrialIdx += 1;
    const remaining = experimentState.sequences[phase].length;

    if (experimentState.currentTrialIdx < remaining) {
      startCurrentTrial();
    } else {
      advancePhase();
    }
  }

  function advancePhase() {
    const justFinished = currentPhase();
    experimentState.currentPhaseIdx += 1;
    experimentState.currentTrialIdx = 0;

    if (experimentState.currentPhaseIdx >= PHASE_ORDER.length) {
      // Alle Phasen durch — erst Survey, dann End-Screen (passiert in main.js
      // nach Submit). Falls keine Survey-Callback gesetzt: direkt End-Screen.
      const summary = window.logger.getSummary();
      summary.scoresByPhase = experimentState.scoresByPhase;
      if (callbacks.setProgressVisible) callbacks.setProgressVisible(false);
      if (callbacks.showSurvey) {
        callbacks.showSurvey(summary);
      } else {
        callbacks.showEnd(summary);
      }
      return;
    }

    // Nach der Practice-Phase: erst Instructions + Quiz, dann erst die
    // Baseline-Phase starten. Falls Quiz schon bestanden war (z.B. via
    // resumePhases-Aufruf nach Pass), normales Phase-Intro.
    if (justFinished === 'practice' && !experimentState.quizPassed) {
      if (callbacks.showInstructions) {
        callbacks.showInstructions(false);
        return;
      }
    }
    showPhaseIntro();
  }

  /**
   * Wird aus main.js gerufen, sobald der Teilnehmer das Quiz bestanden hat.
   * Setzt das Flag, blendet den Progress-Balken ein und startet die
   * Baseline-Phase mit Intro.
   */
  function startMainFromInstructions() {
    experimentState.quizPassed = true;
    if (callbacks.setProgressVisible) callbacks.setProgressVisible(true);
    if (callbacks.updateProgress) {
      callbacks.updateProgress(
        experimentState.mainTrialsCompleted,
        experimentState.totalMainTrials
      );
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
    onHintReceived,
    startMainFromInstructions,
    getState
  };
})();
