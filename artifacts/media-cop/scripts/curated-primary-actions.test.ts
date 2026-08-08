import { readFileSync } from 'node:fs';

const curated = readFileSync(
  new URL('../client/src/pages/Curated.tsx', import.meta.url),
  'utf8',
);
const feedback = readFileSync(
  new URL('../client/src/components/CuratedFeedbackDialog.tsx', import.meta.url),
  'utf8',
);
const button = readFileSync(
  new URL('../client/src/components/ui/button.tsx', import.meta.url),
  'utf8',
);
const css = readFileSync(
  new URL('../client/src/index.css', import.meta.url),
  'utf8',
);

let failures = 0;
function check(label: string, ok: boolean): void {
  if (ok) {
    console.log(`[curated-primary-actions] OK   ${label}`);
  } else {
    failures++;
    console.error(`[curated-primary-actions] FAIL ${label}`);
  }
}

function openingButtonTag(source: string, testId: string): string {
  const testIdIndex = source.indexOf(`data-testid="${testId}"`);
  if (testIdIndex < 0) return '';
  const start = source.lastIndexOf('<Button', testIdIndex);
  const end = source.indexOf('>', testIdIndex);
  return start >= 0 && end >= 0 ? source.slice(start, end + 1) : '';
}

const curatedPrimaryIds = [
  'button-confirm-link',
  'button-top-stories-link-merge',
  'button-top-stories-confirm-link-merge',
  'button-ie-scrub-download',
  'button-config-done',
  'button-add-custom-feed-keyword',
  'button-done-custom-feed',
  'button-detail-open',
  'button-copy-single',
];

for (const testId of curatedPrimaryIds) {
  check(
    `${testId} uses the shared Curated primary treatment`,
    openingButtonTag(curated, testId).includes('variant="curated"'),
  );
}

for (const testIdPrefix of [
  'button-save-priority-reason-',
  'button-save-priority-',
  'button-save-replace-link-',
  'button-confirm-move-member-',
  'button-save-classification-',
  'button-save-headline-',
  'button-ai-assist-',
  'button-save-edit-photo-',
]) {
  const testIdIndex = curated.indexOf(`data-testid={\`${testIdPrefix}`);
  const start = curated.lastIndexOf('<Button', testIdIndex);
  const end = curated.indexOf('>', testIdIndex);
  const tag = start >= 0 && end >= 0 ? curated.slice(start, end + 1) : '';
  check(
    `${testIdPrefix}* uses the shared Curated primary treatment`,
    tag.includes('variant="curated"'),
  );
}

check(
  'feedback submission uses the Curated primary treatment in its portaled dialog',
  openingButtonTag(feedback, 'button-feedback-submit').includes('variant="curated"'),
);
check(
  'Curated variant is token-driven and keeps explicit hover and focus states',
  button.includes('curated:') &&
    button.includes('bg-curated-accent') &&
    button.includes('text-curated-action-foreground') &&
    button.includes('border-curated-accent') &&
    button.includes('hover:bg-curated-action-hover') &&
    button.includes('focus-visible:ring-curated-accent'),
);
check(
  'light and dark themes both define the exact brand fill and readable action tokens',
  (css.match(/--curated-accent: 196\.634 46\.119% 57\.059%;/g) ?? []).length === 2 &&
  (css.match(/--curated-action-foreground:/g) ?? []).length === 2 &&
    (css.match(/--curated-action-hover:/g) ?? []).length === 2,
);
check(
  'global default buttons retain the application primary palette',
  button.includes('"bg-primary text-primary-foreground border border-primary-border"'),
);

if (failures > 0) {
  console.error(`\n[curated-primary-actions] ${failures} check(s) FAILED`);
  process.exit(1);
}

console.log('\n[curated-primary-actions] all checks passed');