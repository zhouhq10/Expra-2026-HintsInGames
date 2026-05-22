/**
 * logger.js
 *
 * Sammelt pro Trial einen Datensatz und exportiert am Ende eine CSV-Datei.
 *
 * Spalten siehe CSV_COLUMNS unten — die Reihenfolge entspricht dem Briefing.
 * Zusätzliche Spalten:
 *   - condition_assigned: 'url' oder 'random' (woher kam die Bedingung?)
 *   - was_skipped:        true wenn der Trial übersprungen wurde
 *   - is_bottleneck:      true wenn dieser Trial die Bottleneck-Aufgabe ist
 *
 * Hängt globales Objekt `logger` an `window`.
 */
(function () {
  'use strict';

  const CSV_COLUMNS = [
    'participant_id',
    'condition',
    'condition_assigned',
    'phase',
    'trial_id',
    'sequence',
    'correct_answer',
    'participant_answer',
    'is_correct',
    'was_skipped',
    'is_bottleneck',
    'solving_time_ms',
    'num_attempts',
    'num_wrong_attempts',
    'hint_used',
    'hint_trigger',
    'time_to_first_hint_ms',
    'hint_count',
    'hint_texts',
    'llm_model',
    'timestamp'
  ];

  // Interner Puffer aller Trial-Records.
  const records = [];

  /**
   * Fügt einen Trial-Record hinzu.
   * @param {Object} record - keys siehe CSV_COLUMNS, fehlende werden zu ''.
   */
  function logTrial(record) {
    records.push(record);
  }

  /** Anzahl bisher geloggter Trials (für Debug / Tests). */
  function count() {
    return records.length;
  }

  /**
   * Erzeugt einen CSV-String aus allen bisherigen Records.
   * Quotet Felder, die Komma, Anführungszeichen oder Zeilenumbruch enthalten.
   */
  function buildCsv() {
    const rows = [CSV_COLUMNS.join(',')];
    for (const rec of records) {
      const cells = CSV_COLUMNS.map((col) => csvEscape(rec[col]));
      rows.push(cells.join(','));
    }
    return rows.join('\n');
  }

  /**
   * Triggert einen CSV-Download über einen temporären Blob.
   * @param {string} participantId
   * @param {string} condition
   */
  function downloadCsv(participantId, condition) {
    const csv = buildCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const filename = buildFilename(participantId, condition);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Browser-Hinweis: createObjectURL hält den Blob im Speicher, bis revoked.
    URL.revokeObjectURL(url);
  }

  function buildFilename(participantId, condition) {
    const safeId = sanitizeForFilename(participantId || 'anon');
    const safeCond = sanitizeForFilename(condition || 'unknown');
    // ISO-Timestamp ohne Doppelpunkte (Windows-kompatibel).
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return `experiment_${safeId}_${safeCond}_${ts}.csv`;
  }

  function sanitizeForFilename(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /**
   * CSV-Escape: leere Werte als '', Werte mit Komma/Quote/Newline gequotet,
   * interne Quotes verdoppelt.
   */
  function csvEscape(value) {
    if (value === undefined || value === null) return '';
    const s = String(value);
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  window.logger = { logTrial, count, buildCsv, downloadCsv, CSV_COLUMNS };
})();
