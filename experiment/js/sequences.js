/**
 * sequences.js
 *
 * Lädt data/sequences.json und gruppiert die Einträge nach Phase.
 * Sortiert pro Phase nach difficulty (aufsteigend), so dass
 * experiment.js sich um Reihenfolge nicht selbst kümmern muss.
 *
 * Hängt globales Objekt `sequencesModule` an `window`.
 */
(function () {
  'use strict';

  /**
   * Lädt die Sequenzen vom Server.
   * @returns {Promise<{ baseline: Array, training: Array, test: Array }>}
   */
  async function loadSequences() {
    // Relative URL — funktioniert nur über HTTP(S), nicht über file://.
    const response = await fetch('data/sequences.json');
    if (!response.ok) {
      throw new Error(
        `sequences.json konnte nicht geladen werden (HTTP ${response.status}).`
      );
    }

    const all = await response.json();
    if (!Array.isArray(all)) {
      throw new Error('sequences.json hat kein Array auf der obersten Ebene.');
    }

    return groupByPhase(all);
  }

  /**
   * Liefert die anzuzeigenden Tokens eines Trials inkl. der Lücke "?".
   * `sequence` enthält die sichtbaren Zahlen (als Strings, ohne die Lücke);
   * `blank_index` gibt an, an welcher Position die Lücke eingefügt wird.
   * Fehlt `blank_index`, sitzt die Lücke am Ende ("nächste Zahl").
   * @returns {string[]}
   */
  function trialTokens(trial) {
    const tokens = (trial.sequence || []).map(String);
    const idx =
      Number.isInteger(trial.blank_index) ? trial.blank_index : tokens.length;
    const clamped = Math.max(0, Math.min(idx, tokens.length));
    tokens.splice(clamped, 0, '?');
    return tokens;
  }

  /** Wie trialTokens, aber als ein String mit gewähltem Trennzeichen. */
  function trialText(trial, separator) {
    return trialTokens(trial).join(separator);
  }

  /** Gruppiert nach Phase und sortiert jede Gruppe nach difficulty. */
  function groupByPhase(all) {
    const grouped = { baseline: [], training: [], test: [] };

    for (const seq of all) {
      if (!grouped[seq.phase]) {
        console.warn('Unknown phase, skipped:', seq.phase, seq.id);
        continue;
      }
      grouped[seq.phase].push(seq);
    }

    for (const phase of Object.keys(grouped)) {
      grouped[phase].sort((a, b) => (a.difficulty || 0) - (b.difficulty || 0));
    }

    return grouped;
  }

  window.sequencesModule = { loadSequences, trialTokens, trialText };
})();
