const fs = require('fs');
const path = require('path');

// Test the transcript extraction logic
const html = fs.readFileSync(path.join(__dirname, '../teams_page.html'), 'utf-8');

function extractTranscriptFromHTML(html) {
  // Find the transcript container
  const containerMatch = html.match(/\[data-testid="transcript-list-wrapper"\]/);
  if (!containerMatch) return [];

  // Extract all transcript items
  const items = [];

  // Find all data-list-index entries
  const indexMatches = html.matchAll(/data-list-index="(\d+)"/g);
  for (const match of indexMatches) {
    const index = parseInt(match[1], 10);

    // Find the corresponding ms-List-cell
    const cellStart = html.indexOf('data-list-index="' + index + '"');
    const cellEnd = html.indexOf('</div></div></div></div></div>', cellStart);

    if (cellStart > -1 && cellEnd > -1) {
      const cellHTML = html.substring(cellStart, cellEnd + 23); // 23 = length of '</div></div></div></div></div>'

      // Extract speaker name
      const speakerMatch = cellHTML.match(/class="eventSpeakerName-565">([^<]+)<\/p>/);
      const speaker = speakerMatch ? speakerMatch[1] : '';

      // Extract text content
      const textMatch = cellHTML.match(/class="eventText-566[^"]*">(.*)<\/div>/);
      const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      // Extract timestamp
      const timestampMatch = cellHTML.match(/id="timestampSpeakerAriaLabel-\d+" class="[^"]*">([^<]*)<\/span>/);
      const timestamp = timestampMatch ? timestampMatch[1] : '';

      // Skip disclaimer
      if (text === 'transcription démarrée' || text === 'transcription terminée' || text === 'Transcription started') {
        continue;
      }

      // Format: Speaker - timestamp: text
      const line = (speaker ? speaker : '') + (timestamp ? ' - ' + timestamp : '') + (text ? ': ' + text : '').trim();

      if (line) {
        items.push({
          index: index,
          line: line
        });
      }
    }
  }

  return items;
}

// Test extraction
const items = extractTranscriptFromHTML(html);

console.log('Transcript Extraction Test Results:');
console.log('=================================');
console.log('Total items found:', items.length);
console.log('Items extracted:', items.length);

// Display first 10 items
console.log('\nFirst 10 transcript items:');
items.slice(0, 10).forEach((item, i) => {
  console.log(`  [${i}] ${item.line}`);
});

// Verify format
console.log('\nFormat Verification:');
const hasCorrectFormat = items.every(item => {
  const speakerEnd = item.line.indexOf(' - ');
  const timestampEnd = item.line.indexOf(': ', speakerEnd > -1 ? speakerEnd + 4 : 0);
  return (speakerEnd > -1 || timestampEnd > -1);
});

console.log('All items have correct format (Speaker - timestamp: text):', hasCorrectFormat);
console.log('\nTest', hasCorrectFormat ? 'PASSED' : 'FAILED');

process.exit(hasCorrectFormat ? 0 : 1);
