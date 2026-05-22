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

  window.sequencesModule = { loadSequences };
})();
