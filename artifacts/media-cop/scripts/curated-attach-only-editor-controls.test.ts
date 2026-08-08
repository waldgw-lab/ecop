import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../client/src/pages/Curated.tsx', import.meta.url),
  'utf8',
);

let failures = 0;
function check(label: string, ok: boolean): void {
  if (ok) {
    console.log(`[attach-only-editor-controls] OK   ${label}`);
  } else {
    failures++;
    console.error(`[attach-only-editor-controls] FAIL ${label}`);
  }
}

const contrastStart = source.indexOf('function ContrastSourceRow(');
const contrastEnd = source.indexOf('// -----------------------------------------------------------------------------', contrastStart + 1);
const contrastSource = source.slice(contrastStart, contrastEnd);

const relocationStart = source.indexOf('const renderAttachOnlyMemberControls =');
const relocationEnd = source.indexOf('// Render a section', relocationStart);
const relocationSource = source.slice(relocationStart, relocationEnd);

const regularControlsStart = source.indexOf('data-testid={`row-member-editor-controls-${a.id}`}');
const regularControlsEnd = source.indexOf('</span>', regularControlsStart);
const regularControlsSource = source.slice(regularControlsStart, regularControlsEnd);

check(
  'CPC/contrast rows accept injected editor membership controls',
  contrastSource.includes('editorControls?: React.ReactNode') &&
    contrastSource.includes('{editorControls}'),
);
check(
  'attach-only relocation controls stay editor-gated',
  relocationSource.includes('if (!hasAccess || !a.url || !story) return null'),
);
check(
  'attach-only relocation offers detach and move',
  relocationSource.includes('<EvictMemberControl') &&
    relocationSource.includes('<MoveMemberControl'),
);
check(
  'attach-only relocation never exposes the content-kind/reclassification control',
  !relocationSource.includes('<MemberKindControl'),
);
check(
  'regular attached rows suppress content-kind/reclassification while retaining membership controls',
  regularControlsSource.includes('tierOf(a) === "contributing"') &&
    regularControlsSource.includes('<MemberKindControl') &&
    regularControlsSource.includes('<EvictMemberControl') &&
    regularControlsSource.includes('<MoveMemberControl'),
);
check(
  'all contrast row variants receive relocation controls',
  (source.match(/editorControls=\{renderAttachOnlyMemberControls\(/g) ?? []).length === 3,
);

if (failures > 0) {
  console.error(`\n[attach-only-editor-controls] ${failures} check(s) FAILED`);
  process.exit(1);
}

console.log('\n[attach-only-editor-controls] all checks passed');