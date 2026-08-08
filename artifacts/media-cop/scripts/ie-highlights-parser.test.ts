// Unit tests for the news-scrub IE Highlights parsers (server/newsScrubParser.ts).
// Covers both real scrub templates plus the fallback precedence. Exit 0 = pass,
// 1 = fail (harness-reliability convention).
import {
  parseIeHighlightsSection,
  parseMajorNarrativesSection,
  parseNewsScrubHighlights,
  type IeHighlightGroup,
} from '../server/newsScrubParser';
import {
  formatIeHighlightsIntro,
  formatIeNarrativeLabel,
} from '../client/src/lib/ieHighlightsPresentation';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}
function summary(gs: IeHighlightGroup[]) {
  return gs.map((g) => `${g.group}(t${g.trending.length}/b${g.breaking.length})`).join(', ');
}

// Template 1: "IE Highlights" with o-bullets + Top Trending / Brealking sub-headers.
const OLD_FORMAT = [
  'IE Highlights',
  'Major IE narratives included:',
  'o \tGlobal IE',
  ' \tTop Trending Narratives',
  '• \tU.S.-Iran Peace Talks Progress in Qatar',
  ' \tBreaking/Notable Stories',
  '• \tTurkey tightens security ahead of NATO summit',
  '• \tUkraine strikes Russian oil refinery',
  'o \tPentagon/NATSEC',
  ' \tTop Trending Narratives',
  '• \tNavy helicopter emergency landing in Arabian Sea',
  'Key Social Media',
  'o \tPOTUS',
].join('\n');

// Template 2: numbered "MAJOR IR NARRATIVES" table of contents, no IE Highlights.
const NEW_FORMAT = [
  'UNCLASSIFIED',
  '1',
  'BLUF: As of 1700, the main narrative ...',
  '***',
  'MAJOR IR NARRATIVES',
  'Global IE',
  '1.\tUS and Iran Hold Indirect Talks in Qatar',
  '2.\tRussia Plunges into Summer Fuel Crisis, Begins Imports from India',
  '3.\tShip Runs Aground in the Strait of Hormuz',
  'Pentagon/NATSEC',
  '4.\tNavy Helicopter Makes Emergency Landing in the Arabian Sea',
  '5.\tDEPSECWAR and VCJCS HAC-D Briefing',
  'Domestic IE',
  '7.\tNSTR',
  'Key Social Media',
  '8.\tPOTUS',
  '9.\tSenior Leadership',
  '***',
  'GLOBAL IE',
  '1. US and Iran Hold Indirect Talks in Qatar',
].join('\n');

const NEITHER = 'UNCLASSIFIED\nBLUF: nothing here\nLatest Brent crude ...';

console.log('== Template 1: IE Highlights (old format) ==');
{
  const g = parseIeHighlightsSection(OLD_FORMAT);
  check('parses 2 regions', g.length === 2, summary(g));
  const global = g.find((x) => /global/i.test(x.group));
  const pentagon = g.find((x) => /pentagon/i.test(x.group));
  check('Global IE present with trending + breaking', !!global && global.trending.length === 1 && global.breaking.length === 2, global && summary([global]));
  check('Pentagon/NATSEC present', !!pentagon && pentagon.trending.length === 1, pentagon && summary([pentagon]));
  check('Key Social Media excluded', !g.some((x) => /social/i.test(x.group)));
}

console.log('== Template 2: MAJOR IR NARRATIVES (new format) ==');
{
  const g = parseMajorNarrativesSection(NEW_FORMAT);
  check('parses 2 regions (NSTR + social dropped)', g.length === 2, summary(g));
  const global = g.find((x) => /global/i.test(x.group));
  const pentagon = g.find((x) => /pentagon/i.test(x.group));
  check('Global IE has 3 headlines', !!global && global.trending.length === 3, global && summary([global]));
  check('Pentagon/NATSEC has 2 headlines', !!pentagon && pentagon.trending.length === 2, pentagon && summary([pentagon]));
  check('Domestic IE (NSTR) dropped', !g.some((x) => /domestic/i.test(x.group)));
  check('Key Social Media excluded', !g.some((x) => /social/i.test(x.group)));
  check('headline text preserved', !!global && global.trending[0] === 'US and Iran Hold Indirect Talks in Qatar', global?.trending[0]);
}

console.log('== Fallback precedence ==');
{
  // New format alone -> fallback populates.
  check('new-format-only -> non-empty via wrapper', parseNewsScrubHighlights(NEW_FORMAT).length === 2);
  // Old format -> primary wins (and its region shape is preserved).
  const w = parseNewsScrubHighlights(OLD_FORMAT);
  check('old-format -> primary path used', w.length === 2 && w.some((x) => x.breaking.length > 0));
  // Neither -> empty.
  check('neither template -> empty', parseNewsScrubHighlights(NEITHER).length === 0);
}

console.log('== IE preview presentation ==');
{
  const known: Array<[string, string]> = [
    ['WHEM: headline', 'Western Hemisphere: headline'],
    ['centcom : headline', 'Middle East : headline'],
    ['PACOM: headline', 'Indo-Pacific: headline'],
    ['indopacom: headline', 'Indo-Pacific: headline'],
    ['EUCOM: headline', 'Europe: headline'],
    ['africom: headline', 'Africa: headline'],
  ];
  for (const [raw, expected] of known) {
    check(`${raw.split(':')[0].trim()} prefix maps`, formatIeNarrativeLabel(raw) === expected);
  }

  check(
    'leading spacing is preserved while matching case-insensitively',
    formatIeNarrativeLabel('  wHeM  : headline') === '  Western Hemisphere  : headline',
  );
  check(
    'unknown leading prefix passes through',
    formatIeNarrativeLabel('NORTHCOM: headline') === 'NORTHCOM: headline',
  );
  check(
    'known area elsewhere in headline is not rewritten',
    formatIeNarrativeLabel('Talks move to CENTCOM: headquarters') === 'Talks move to CENTCOM: headquarters',
  );
  check(
    'partial leading token is not rewritten',
    formatIeNarrativeLabel('PACOMMAND: headline') === 'PACOMMAND: headline',
  );
  check(
    'non-prefix leading area name is not rewritten',
    formatIeNarrativeLabel('PACOM exercises begin') === 'PACOM exercises begin',
  );

  const raw = parseIeHighlightsSection([
    'IE Highlights',
    'o Global IE',
    'Top Trending Narratives',
    '• WHEM: Original parsed headline',
  ].join('\n'));
  const rawHeadline = raw[0]?.trending[0];
  const displayHeadline = rawHeadline ? formatIeNarrativeLabel(rawHeadline) : '';
  check('preview label transforms the headline', displayHeadline === 'Western Hemisphere: Original parsed headline');
  check('raw parser headline remains unchanged', raw[0]?.trending[0] === 'WHEM: Original parsed headline');
  check('raw parser group heading remains unchanged', raw[0]?.group === 'Global IE');

  const localDate = new Date(2026, 7, 5, 16, 43);
  check(
    'compact intro uses day-month and 12-hour local time',
    formatIeHighlightsIntro(localDate) === 'Major narratives as of 05 Aug, 04:43 PM included:',
    formatIeHighlightsIntro(localDate),
  );
  check(
    'malformed timestamp has a compact graceful fallback',
    formatIeHighlightsIntro(new Date('not-a-date')) === 'Major narratives as of — included:',
  );
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
