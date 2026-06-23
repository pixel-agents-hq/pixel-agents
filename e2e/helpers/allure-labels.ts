import type { TestInfo } from '@playwright/test';
import { allure } from 'allure-playwright';

/**
 * Map `@area:<tag>` to a human-readable Allure epic name. Keep this in sync
 * with the "What this suite covers" section of e2e/README.md.
 */
const AREA_TO_EPIC: Record<string, string> = {
  spawn: 'Spawn paths',
  lifecycle: 'Lifecycle regressions',
  'cross-cutting': 'Cross-cutting checks',
  teams: 'Teams routing',
  matrix: 'Hooks-off matrix',
  standalone: 'Standalone server',
  pets: 'Pet system',
  carpet: 'Carpet system',
  areas: 'Areas (zoning) system',
};

/**
 * Apply Allure epic label derived from the test's @area: tag. Called from an
 * auto-fixture in pixel-agents.ts and standalone.ts so every test in the
 * suite gets grouped in the Allure dashboard's Behaviors view without
 * per-test annotation.
 *
 * We only set the epic (top-level grouping). Allure-playwright auto-populates
 * `suite` (from the spec file path) and `subSuite` (from the test.describe
 * title), which gives the finer-grained navigation for free. Manually
 * setting `feature` would just duplicate `subSuite`.
 */
export async function applyAllureLabels(testInfo: TestInfo): Promise<void> {
  // Playwright strips '@' from tags: `@area:lifecycle` -> `area:lifecycle`.
  const areaTag = testInfo.tags.find((t) => /^@?area:/.test(t));
  if (!areaTag) return;
  const area = areaTag.replace(/^@?area:/, '');
  const epic = AREA_TO_EPIC[area] ?? `area:${area}`;
  await allure.epic(epic);
}
