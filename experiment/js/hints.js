/**
 * hints.js
 *
 * Holt Hints zur Laufzeit vom Backend-Endpoint /api/hint, der wiederum
 * Claude (Anthropic) aufruft. Pro Trial wird eine Multi-Turn-Konversation
 * gehalten — der Proband kann nach dem ersten Hint Rückfragen stellen,
 * und das LLM bleibt strikt in seinem Hint-Typ (per System-Prompt).
 *
 * Wichtig:
 *   - Der API-Key ist NICHT im Frontend, sondern serverseitig in `.env`.
 *   - Die History wird im Frontend gehalten und bei jedem Request
 *     mitgeschickt (Server ist stateless).
 *   - In `control` und ausserhalb der Trainingsphase passiert hier nichts.
 *
 * Hängt globales Objekt `hints` an `window`.
 */
(function () {
  'use strict';

  // Persistenter Modul-State (über Trials hinweg).
  let condition = null;
  let dom = {
    lightbulbBtn: null,
    panelEl: null,
    closeBtn: null,
    messagesEl: null,
    followupForm: null,
    followupInput: null,
    errorEl: null
  };

  // Per-Trial-State (in onTrialStart zurückgesetzt).
  let currentTrial = null;
  let trialStartTs = null;
  let conversation = []; // Array von { role: 'user'|'assistant', content }
  let hintTexts = [];    // nur die assistant-Antworten, fürs CSV
  let hintCount = 0;
  let hintTrigger = 'none'; // 'manual' | 'auto' | 'none'
  let timeToFirstHintMs = null;
  let llmModel = '';
  let inFlight = false;

  // ---------- Public API ----------------------------------------------

  function init(cond, refs) {
    condition = cond;
    dom = { ...dom, ...refs };

    // Defensiv: alle erwarteten Refs prüfen, damit ein versehentlich alter
    // main.js / hints.js (z.B. aus einem Browser-Cache nach Iteration-Update)
    // einen klaren Fehler liefert statt später still zu crashen.
    const required = [
      'lightbulbBtn', 'panelEl', 'closeBtn', 'messagesEl',
      'followupForm', 'followupInput', 'errorEl'
    ];
    for (const key of required) {
      if (!dom[key]) {
        throw new Error(
          `hints.init: DOM element '${key}' is missing. Most likely your ` +
          `browser is serving a cached, outdated JS file. ` +
          `A hard reload (Cmd+Shift+R / Ctrl+Shift+R) should fix this.`
        );
      }
    }

    // Klick auf die Glühbirne öffnet das Chat-Panel. Wenn in diesem Trial
    // noch kein Hint geholt wurde, triggert der Klick den ersten Request.
    // Folge-Klicks öffnen das Panel nur (zeigen die bestehenden Bubbles wieder).
    dom.lightbulbBtn.addEventListener('click', () => {
      openPanel();
      if (hintCount === 0 && !inFlight) {
        requestHint(/* userMessage */ null, 'manual');
      }
    });

    // Schließen-Button + Escape-Taste schließen das Panel.
    dom.closeBtn.addEventListener('click', closePanel);
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !dom.panelEl.hidden) {
        closePanel();
      }
    });

    // Rückfragen via Form-Submit (Enter im Eingabefeld).
    dom.followupForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = dom.followupInput.value.trim();
      if (!text) return;
      dom.followupInput.value = '';
      // Rückfragen sind immer User-initiiert -> trigger bleibt der erste.
      requestHint(text, hintTrigger);
    });
  }

  function openPanel() {
    if (!isHintAvailable()) return;
    dom.panelEl.hidden = false;
    // Wenn das Followup-Form sichtbar ist (nach erstem Hint), Fokus reingeben.
    if (!dom.followupForm.hidden) {
      dom.followupInput.focus();
    }
  }

  function closePanel() {
    dom.panelEl.hidden = true;
  }

  function onTrialStart(trial) {
    currentTrial = trial;
    trialStartTs = performance.now();
    conversation = [];
    hintTexts = [];
    hintCount = 0;
    hintTrigger = 'none';
    timeToFirstHintMs = null;
    llmModel = '';
    inFlight = false;

    resetPanel();
    dom.lightbulbBtn.hidden = !isHintAvailable();
  }

  function onTrialEnd() {
    dom.lightbulbBtn.hidden = true;
    resetPanel();
  }

  function getTrialHintData() {
    return {
      hint_used: hintCount > 0,
      hint_trigger: hintTrigger,
      time_to_first_hint_ms:
        timeToFirstHintMs === null ? '' : timeToFirstHintMs,
      hint_count: hintCount,
      // Hints mit `||` joinen — CSV-Logger quotet automatisch wegen Komma.
      hint_texts: hintTexts.join(' || '),
      llm_model: llmModel
    };
  }

  // ---------- Internals -----------------------------------------------

  function isHintAvailable() {
    if (!currentTrial) return false;
    if (condition === 'control') return false;
    if (currentTrial.phase !== 'training') return false;
    return true;
  }

  function resetPanel() {
    dom.panelEl.hidden = true;
    dom.messagesEl.innerHTML = '';
    dom.followupForm.hidden = true;
    dom.followupInput.value = '';
    dom.errorEl.hidden = true;
    dom.errorEl.textContent = '';
  }

  /**
   * Hauptlogik: ruft das Backend, hängt Antwort an die Konversation.
   * @param {string|null} userMessage - null beim ersten Klick
   * @param {string} trigger - 'manual' (erster Klick) oder bestehend (Rückfrage)
   */
  async function requestHint(userMessage, trigger) {
    if (!isHintAvailable()) return;
    if (inFlight) return; // Doppelklicks ignorieren

    inFlight = true;
    dom.errorEl.hidden = true;

    // Bei Rückfrage: User-Bubble sofort rendern, History mitnehmen.
    if (userMessage) {
      conversation.push({ role: 'user', content: userMessage });
      appendBubble('user', userMessage);
    }

    dom.followupForm.hidden = true;

    try {
      const resp = await fetch('/api/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          condition,
          trial: {
            id: currentTrial.id,
            sequence: currentTrial.sequence,
            answer: currentTrial.answer,
            rule: currentTrial.rule || ''
          },
          // Beim ersten Klick ist history leer und user_message=null —
          // der Server schickt dann eine neutrale Eröffnungsfrage.
          history: conversation.slice(0, userMessage ? -1 : conversation.length),
          user_message: userMessage
        })
      });

      if (!resp.ok) {
        const detail = await safeReadDetail(resp);
        throw new Error(detail || `HTTP ${resp.status}`);
      }

      const data = await resp.json();
      const hintText = (data.hint || '').trim();
      if (!hintText) throw new Error('Empty response from server.');

      // Successful hint — append, log, bookkeep.
      conversation.push({ role: 'assistant', content: hintText });
      hintTexts.push(hintText);
      llmModel = data.model || llmModel;
      hintCount += 1;
      if (hintCount === 1) {
        hintTrigger = trigger;
        timeToFirstHintMs = Math.round(performance.now() - trialStartTs);
      }

      appendBubble('assistant', hintText);
      dom.followupForm.hidden = false;
      // Falls das Panel offen ist, Fokus ins Eingabefeld für Rückfrage.
      if (!dom.panelEl.hidden) {
        dom.followupInput.focus();
      }
    } catch (err) {
      console.error('Hint request failed:', err);
      dom.errorEl.textContent =
        'Hint currently unavailable. Please try again, or solve the task without a hint.';
      dom.errorEl.hidden = false;
      // Bei Fehler nach Rückfrage: User-Bubble bleibt sichtbar, aber wir
      // entfernen sie aus der Konversation, damit ein erneuter Versuch
      // nicht doppelte User-Turns erzeugt.
      if (userMessage) {
        conversation.pop();
      }
    } finally {
      inFlight = false;
    }
  }

  function appendBubble(role, text) {
    const el = document.createElement('div');
    el.className = 'hint-bubble' + (role === 'user' ? ' user' : '');
    el.textContent = text;
    dom.messagesEl.appendChild(el);
    // Auto-scroll, damit neue Nachrichten immer sichtbar sind.
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  }

  async function safeReadDetail(resp) {
    try {
      const j = await resp.json();
      return j && j.detail ? String(j.detail) : '';
    } catch (_) {
      return '';
    }
  }

  window.hints = { init, onTrialStart, onTrialEnd, getTrialHintData };
})();
