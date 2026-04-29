# MinuteStash

Firefox extension to extract Microsoft Teams transcript entries and download them as a plain text file.

## Why This Exists

In some Teams contexts, participants can read transcript entries but cannot directly download them. This extension automates:

1. Detecting transcript rows in the Teams UI
2. Scrolling through the virtualized list until all entries are collected
3. Building a text file
4. Triggering a download through the browser

## Features

- One-click extraction from the popup
- Progress status in popup while extraction runs
- Speaker and timestamp parsing when available
- Automatic file download with date-based filename
- State recovery on popup reopen (state is persisted in extension storage)

## Project Structure

```
minutestash/
     background.js   # orchestration, state, download
     content.js      # Teams DOM parsing + scrolling extraction
     popup.html      # popup UI
     popup.js        # popup state rendering + user actions
     manifest.json   # extension manifest and permissions
test/
     test-extension.js
     transcript-extractor.test.js
```

## Architecture

### Popup layer

- Files: popup.html, popup.js
- Responsibility: user interaction and display only
- Behavior:
1. Sends startExtraction when user clicks the button
2. Polls getExtractionState on open/refresh
3. Applies extractionStatus updates to progress UI

### Background layer

- File: background.js
- Responsibility: source of truth for extraction lifecycle
- Behavior:
1. Receives startExtraction from popup
2. Injects content.js into target tab
3. Receives transcriptReady or error from content script
4. Saves output via browser.downloads
5. Maintains state per tab and persists it in browser.storage.local

### Content layer

- File: content.js
- Responsibility: Teams-page extraction logic
- Behavior:
1. Locates transcript container elements
2. Scrolls virtualized list in steps
3. Extracts lines (timestamp, speaker, text)
4. Sends transcriptReady back to background

## Runtime Message Protocol

| Message type | Direction | Purpose |
|---|---|---|
| startExtraction | popup -> background | Start extraction for a tab |
| getExtractionState | popup -> background | Read latest known state |
| extractionStatus | background -> popup | Push running/progress/final state |
| transcriptReady | content -> background | Send extracted payload |
| error | content -> background | Report extraction failure |
| saveTranscript | internal/background | Trigger file download |

## Installation (Temporary Add-on in Firefox)

1. Open Firefox and go to about:debugging
2. Select This Firefox
3. Click Load Temporary Add-on
4. Choose minutestash/manifest.json
5. Open a Teams page and pin the extension if needed

Note: Reload the temporary add-on after code changes.

## Usage

1. Open a Teams meeting recording/details page where transcript entries are visible
2. Open the extension popup
3. Click Extract & Download
4. Wait for completion status in popup
5. Find the downloaded transcript-YYYY-MM-DD.txt in your downloads folder

## Development

Install dependencies:

```bash
npm install
```

Available scripts:

```bash
npm test
npm run test:playwright:local
npm run test:playwright:live
```

## Testing Notes

- Local mode expects a local HTML fixture at repository root named teams_page.html
- Live mode opens Teams and requires manual authentication/navigation
- Optional environment variable for live mode:

```bash
TEAMS_STREAM_URL=https://teams.microsoft.com npm run test:playwright:live
```

## Troubleshooting

### Popup resets to idle after reopen

- Ensure extension is reloaded after manifest or background changes
- Confirm transcript extraction actually completed at least once
- State is persisted by background.js using browser.storage.local; if storage is cleared, state is lost

### No transcript extracted

- Make sure transcript entries are visible before starting extraction
- Teams DOM can change; selectors in content.js may need updates

### Test command fails with teams_page.html not found

- Add the expected fixture file in the repository root
- Or use live mode instead

## Limitations

- Firefox-focused (Manifest V2 / gecko settings)
- Relies on Teams DOM selectors that may change
- Very large transcripts depend on scroll/pass thresholds in content.js

## License

ISC
