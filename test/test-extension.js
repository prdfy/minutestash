const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { firefox } = require('playwright');

const ROOT = path.join(__dirname, '..');
const CONTENT_SCRIPT_PATH = path.join(ROOT, 'minutestash', 'content.js');
const LOCAL_PAGE_PATH = path.join(ROOT, 'teams_page.html');
const LIVE_URL = process.env.TEAMS_STREAM_URL || 'https://teams.microsoft.com';
const TRANSCRIPT_SELECTOR = '[data-testid="transcript-list-wrapper"]';

function getContextLabel(target) {
  if ('url' in target && typeof target.url === 'function') {
    return target.url();
  }
  return 'unknown-context';
}

async function contextHasTranscript(target) {
  return target.evaluate((selector) => Boolean(document.querySelector(selector)), TRANSCRIPT_SELECTOR);
}

async function findTranscriptContext(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await contextHasTranscript(page)) {
      return page;
    }

    const frames = page.frames();
    for (const frame of frames) {
      try {
        if (await contextHasTranscript(frame)) {
          return frame;
        }
      } catch {
        // Ignore transient frames that detach while probing.
      }
    }

    await page.waitForTimeout(500);
  }

  const frameUrls = page.frames().map((frame) => frame.url());
  throw new Error(
    `Transcript container not found in page or frames. Open the recording details/transcript view first. Frames seen: ${frameUrls.join(', ')}`
  );
}

async function waitForTranscriptContextWithRetries(page, maxAttempts = 6, timeoutMs = 20000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await findTranscriptContext(page, timeoutMs);
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      console.log(
        `Transcript context not found yet (attempt ${attempt}/${maxAttempts}). ` +
          'Make sure the recording page is open and transcript entries are visible.'
      );
      await waitForEnter('Press Enter to retry transcript detection... ');
    }
  }

  throw new Error('Unable to detect transcript context.');
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function installTestHooks(page) {
  await page.addInitScript(() => {
    globalThis.__extensionTest = {
      messages: [],
      downloads: [],
      lastBlobText: '',
      scriptInjectionMethod: '',
    };

    globalThis.chrome = globalThis.chrome || {};
    globalThis.chrome.runtime = globalThis.chrome.runtime || {};
    globalThis.chrome.runtime.sendMessage = (message) => {
      globalThis.__extensionTest.messages.push(message);
    };

    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob?.type === 'text/plain') {
        blob.text().then((text) => {
          globalThis.__extensionTest.lastBlobText = text;
        });
      }
      return originalCreateObjectURL(blob);
    };

    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedClick() {
      globalThis.__extensionTest.downloads.push({
        download: this.download || '',
        href: this.href || '',
      });
      return originalClick.call(this);
    };
  });
}

async function runContentScript(target, contentScript) {
  try {
    await target.addScriptTag({ path: CONTENT_SCRIPT_PATH });
    await target.evaluate(() => {
      globalThis.__extensionTest.scriptInjectionMethod = 'addScriptTag(path)';
    });
    return;
  } catch {
    await target.evaluate((source) => {
      // Fallback when CSP blocks loading script tags.
      const fn = new Function(source);
      fn();
      globalThis.__extensionTest.scriptInjectionMethod = 'evaluate(new Function)';
    }, contentScript);
  }
}

async function waitForResult(target, timeoutMs) {
  await target.waitForFunction(
    () => {
      const messages = globalThis.__extensionTest?.messages;
      if (!messages || messages.length === 0) {
        return false;
      }
      return messages.some(
        (msg) => msg && (msg.type === 'transcriptReady' || msg.type === 'error')
      );
    },
    null,
    { timeout: timeoutMs }
  );

  return target.evaluate(() => {
    const messages = globalThis.__extensionTest.messages;
    const lastMessage = messages[messages.length - 1] || null;
    return {
      url: globalThis.location.href,
      title: document.title,
      injectionMethod: globalThis.__extensionTest.scriptInjectionMethod,
      messages,
      lastMessage,
      downloads: globalThis.__extensionTest.downloads,
      lastBlobText: globalThis.__extensionTest.lastBlobText,
    };
  });
}

async function main() {
  const mode = getArg('mode', 'local');
  const headless = getArg('headless', 'false') === 'true';
  const timeoutDefault = mode === 'live' ? '180000' : '60000';
  const timeoutMs = Number(getArg('timeout', timeoutDefault));
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');

  const browser = await firefox.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  let executionContext = page;

  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) {
      console.log(`[page ${msg.type()}] ${msg.text()}`);
    }
  });

  try {
    await installTestHooks(page);

    if (mode === 'local') {
      await page.goto(`file://${LOCAL_PAGE_PATH}`);
      console.log('Running local fixture test against teams_page.html...');
      executionContext = page;
      await runContentScript(executionContext, contentScript);
    } else if (mode === 'live') {
      await page.goto(LIVE_URL);
      console.log(`Live mode opened: ${LIVE_URL}`);
      console.log('Please log in, open a recording page, and display transcript entries.');
      await waitForEnter('Press Enter when the transcript list is visible... ');
      executionContext = await waitForTranscriptContextWithRetries(page);
      console.log(`Transcript context: ${getContextLabel(executionContext)}`);
      await runContentScript(executionContext, contentScript);
    } else {
      throw new Error(`Unknown mode: ${mode}. Use --mode=local or --mode=live`);
    }

    const result = await waitForResult(executionContext, timeoutMs);

    console.log('\n=== Playwright extension test result ===');
    console.log(`Mode: ${mode}`);
    console.log(`URL: ${result.url}`);
    console.log(`Title: ${result.title}`);
    console.log(`Injection method: ${result.injectionMethod}`);
    console.log(`Messages: ${result.messages.length}`);

    if (result.lastMessage?.type === 'transcriptReady') {
      console.log(`Transcript entries: ${result.lastMessage.itemCount}`);
      console.log(`Downloads intercepted: ${result.downloads.length}`);
      if (result.downloads[0]) {
        console.log(`Downloaded file name: ${result.downloads[0].download}`);
      }
      console.log(`Extracted text size: ${result.lastBlobText.length} chars`);
      if (result.lastMessage.itemCount <= 0) {
        throw new Error('No transcript entries were extracted.');
      }
      if (!result.lastBlobText?.trim()) {
        throw new Error('Transcript blob text is empty.');
      }
      console.log('Status: PASS');
    } else {
      const messageText = result.lastMessage
        ? JSON.stringify(result.lastMessage)
        : 'No result message received';
      throw new Error(`Status: FAIL. ${messageText}`);
    }

    if (mode === 'live') {
      await waitForEnter('Press Enter to close Firefox... ');
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
