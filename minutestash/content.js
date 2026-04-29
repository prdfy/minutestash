(function() {
  'use strict';

  let container = document.querySelector('[data-testid="transcript-list-wrapper"]');
  if (!container) {
    // This frame doesn't have the transcript — silently skip it.
    return;
  }

  const scrollable = document.querySelector('[data-testid="scroll-to-target-targeted-focus-zone"]');
  if (!scrollable) {
    console.error('[minutestash] Scrollable container not found.');
    browser.runtime.sendMessage({ type: 'error', message: 'Scrollable container not found.' });
    return;
  }

  const surface = scrollable.querySelector('.ms-List-surface');
  if (!surface) {
    console.error('[minutestash] List surface (.ms-List-surface) not found inside scrollable.');
    browser.runtime.sendMessage({ type: 'error', message: 'List surface not found.' });
    return;
  }

  let allLines = [];
  const MAX_SCROLL_STEPS = 300;
  const SETTLE_TIMEOUT_MS = 1500; // max wait per step if no DOM change arrives
  const SETTLE_QUIET_MS = 150;    // how long the DOM must be quiet before we consider it settled
  const BOTTOM_THRESHOLD_PX = 50; // within this many px of the bottom = done
  const MAX_STABILITY = 8;        // consecutive no-new-entry steps needed (only exits at bottom)
  let stabilityCounter = 0;
  let maxScroll = scrollable.scrollHeight - scrollable.clientHeight;

  /**
   * Scroll one step, then wait for the virtualised list to finish rendering
   * new cells before returning. Uses a MutationObserver to detect DOM changes
   * and waits until the DOM has been quiet for SETTLE_QUIET_MS, or bails out
   * after SETTLE_TIMEOUT_MS if nothing changes.
   */
  function scrollAndWaitForRender(distance) {
    return new Promise(resolve => {
      scrollable.scrollTo(0, Math.min(scrollable.scrollTop + distance, maxScroll));

      let quietTimer = null;

      const onQuiet = () => {
        observer.disconnect();
        resolve();
      };

      const reschedule = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(onQuiet, SETTLE_QUIET_MS);
      };

      const observer = new MutationObserver(reschedule);
      observer.observe(surface, { childList: true, subtree: true, characterData: true, attributes: true });

      // Start quiet timer immediately in case the DOM doesn't change at all
      reschedule();

      // Hard cap — never wait longer than SETTLE_TIMEOUT_MS
      setTimeout(() => {
        observer.disconnect();
        clearTimeout(quietTimer);
        resolve();
      }, SETTLE_TIMEOUT_MS);
    });
  }

  function cleanLine(text) {
    return String(text || '').replaceAll(/\s+/g, ' ').trim();
  }

  function isNoiseLine(line) {
    const lower = line.toLowerCase();
    return (
      !line ||
      lower === 'transcription' ||
      lower.includes('transcription started') ||
      lower.includes('transcript') ||
      lower.includes('jump to latest')
    );
  }

  function formatHhMmSs(totalSeconds) {
    const safe = Math.max(0, Number(totalSeconds) || 0);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function normalizeTimestamp(text) {
    const value = cleanLine(text);
    if (!value) return '';

    const colonMatches = [...value.matchAll(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g)];
    if (colonMatches.length > 0) {
      const last = colonMatches.at(-1);
      const a = Number(last[1]);
      const b = Number(last[2]);
      const c = last[3] === undefined ? null : Number(last[3]);
      if (c !== null) {
        return formatHhMmSs(a * 3600 + b * 60 + c);
      }
      return formatHhMmSs(a * 60 + b);
    }

    const hoursMatch = /(\d+)\s*(heures?|heure|hours?|hour|h)\b/i.exec(value);
    const minutesMatch = /(\d+)\s*(minutes?|minute|min|m)\b/i.exec(value);
    const secondsMatch = /(\d+)\s*(secondes?|seconde|seconds?|second|sec|s)\b/i.exec(value);

    const hours = Number(hoursMatch?.[1] || 0);
    const minutes = Number(minutesMatch?.[1] || 0);
    const seconds = Number(secondsMatch?.[1] || 0);

    if (hours || minutes || seconds) {
      return formatHhMmSs(hours * 3600 + minutes * 60 + seconds);
    }

    return '';
  }

  function escapeRegExp(value) {
    return String(value).replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  }

  function stripLeadingMetadata(text, speakerName, time) {
    let value = cleanLine(text);
    if (!value) return '';

    const speakerPattern = speakerName ? escapeRegExp(speakerName) : '';

    const patterns = [
      /^(?:\d+\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*/i,
      /^(?:\d+\s+)?\d+\s+minutes?\s+\d+\s+second(?:e)?s?\s*/i
    ];

    if (speakerPattern) {
      patterns.push(
        new RegExp(String.raw`^${speakerPattern}\s*[-:]*\s*`, 'i'),
        new RegExp(String.raw`^(?:${speakerPattern}\s*)?(?:\d+\s+)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*${speakerPattern})?\s*`, 'i'),
        new RegExp(String.raw`^(?:${speakerPattern}\s*)?(?:\d+\s+)?\d+\s+minutes?\s+\d+\s+second(?:e)?s?(?:\s*${speakerPattern})?\s*`, 'i')
      );
    }

    if (time) {
      const rawTime = String(time).replace(/^0+/, '').replace(/^:/, '');
      const timePattern = escapeRegExp(time);
      patterns.push(new RegExp(String.raw`^${timePattern}\s*`, 'i'));
      if (rawTime) {
        patterns.push(new RegExp(String.raw`^${escapeRegExp(rawTime)}\s*`, 'i'));
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const pattern of patterns) {
        const next = cleanLine(value.replace(pattern, ''));
        if (next !== value) {
          value = next;
          changed = true;
        }
      }
    }

    return value;
  }

  function isMetadataLine(line, speakerName, time) {
    if (!line) return true;
    if (speakerName && line.toLowerCase() === speakerName.toLowerCase()) return true;
    if (time && normalizeTimestamp(line) === time) return true;

    const lowered = line.toLowerCase();
    if (/^(?:\d+\s+)?\d{1,2}:\d{2}(?::\d{2})?$/.test(line)) return true;
    if (/^(?:\d+\s+)?\d+\s+minutes?\s+\d+\s+second(?:e)?s?$/i.test(line)) return true;
    if (speakerName && lowered.includes(speakerName.toLowerCase()) && normalizeTimestamp(line)) return true;

    return false;
  }

  function pickCellText(cell, speakerName, time) {
    // Preferred semantic targets when available.
    const preferred = [
      '[id^="sub-entry-"]',
      '.entryText-556',
      '.eventText-566',
      '[data-testid="transcript-text"]',
    ];

    for (const selector of preferred) {
      const node = cell.querySelector(selector);
      const value = stripLeadingMetadata(node?.textContent, speakerName, time);
      if (value && !isNoiseLine(value)) {
        return value;
      }
    }

    // Fallback: use the last meaningful line from the cell.
    const raw = cell.innerText || '';
    const lines = raw.split('\n')
      .map(cleanLine)
      .filter(line => line && !isNoiseLine(line))
      .filter(line => !isMetadataLine(line, speakerName, time));

    const fallback = lines.at(-1) || '';
    return stripLeadingMetadata(fallback, speakerName, time);
  }

  function pickSpeaker(cell) {
    const node = cell.querySelector('span[class^="itemDisplayName-"]');
    return cleanLine(node?.textContent);
  }

  function pickTimestamp(cell) {
    const node = cell.querySelector('span[id^="Header-timestamp-"]');
    return normalizeTimestamp(node?.textContent);
  }

  function extractItems() {
    const cells = surface.querySelectorAll('.ms-List-cell');
    cells.forEach(cell => {
      const speakerName = pickSpeaker(cell);
      const time = pickTimestamp(cell);
      const transcriptText = pickCellText(cell, speakerName, time);

      if (!transcriptText) return;

      // Skip organizer/header artifacts: speaker label without timestamped speech.
      if (speakerName && !time && transcriptText.toLowerCase() === speakerName.toLowerCase()) {
        return;
      }

      if (speakerName || time) {
        allLines.push(
          (time || '') +
            (speakerName ? ' - ' + speakerName : '') +
            (transcriptText ? ': ' + transcriptText : '')
        );
      } else {
        allLines.push(transcriptText);
      }
    });
  }

  async function run() {
    // Reinitialize per-run state so repeated executions on the same page behave consistently.
    allLines = [];
    stabilityCounter = 0;
    scrollable.scrollTo(0, 0);
    await scrollAndWaitForRender(0);
    maxScroll = scrollable.scrollHeight - scrollable.clientHeight;

    extractItems();

    for (let i = 0; i < MAX_SCROLL_STEPS; i++) {
      await scrollAndWaitForRender(600);

      const newMaxScroll = scrollable.scrollHeight - scrollable.clientHeight;
      if (newMaxScroll > maxScroll) {
        maxScroll = newMaxScroll;
      }

      const before = allLines.length;
      extractItems();
      const after = allLines.length;

      const atBottom = scrollable.scrollTop >= maxScroll - BOTTOM_THRESHOLD_PX;

      if (after === before) {
        stabilityCounter++;
        // Only exit early once we've actually reached the bottom
        if (atBottom && stabilityCounter >= MAX_STABILITY) {
          break;
        }
      } else {
        stabilityCounter = 0;
      }
    }

    // Build transcript payload and let popup/background handle saving.
    const text = allLines.join('\n');
    const fileName = 'transcript-' + new Date().toISOString().slice(0, 10) + '.txt';

    // Notify popup
    browser.runtime.sendMessage({
      type: 'transcriptReady',
      itemCount: allLines.length,
      text,
      fileName
    });
  }

  run();
})();
