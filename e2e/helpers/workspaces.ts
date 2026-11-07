import { expect, type Locator, type Page } from '@playwright/test';

const WORKSPACE_TIMEOUT_MS = 15_000;

/** The switcher's tab strip. */
export function getWorkspaceSwitcher(page: Page): Locator {
  return page.getByTestId('workspace-switcher');
}

/** A tab by its exact accessible name (the name plus any badge text). */
export function getWorkspaceTab(page: Page, name: string): Locator {
  return getWorkspaceSwitcher(page).getByRole('tab', { name, exact: true });
}

export function getNewWorkspaceButton(page: Page): Locator {
  return getWorkspaceSwitcher(page).getByRole('button', { name: 'New workspace', exact: true });
}

export function getWorkspaceModal(page: Page): Locator {
  return page.getByTestId('workspace-modal');
}

/** One Directory's checkbox row in the Workspace modal. */
export function getWorkspaceDirectoryRow(modal: Locator, directoryName: string): Locator {
  return modal
    .getByTestId('workspace-directories')
    .locator('label')
    .filter({ has: modal.page().getByText(directoryName, { exact: true }) });
}

/** The tabs' agent cards: only the shown Workspace's agents have one. */
export function getAgentCards(page: Page): Locator {
  return page.getByTitle(/^Agent \d+$/);
}

/** Wait until the switcher has rendered the server's Workspace list. */
export async function waitForWorkspaceSwitcher(page: Page): Promise<void> {
  await expect(getWorkspaceTab(page, 'Default')).toBeVisible({ timeout: 30_000 });
}

/**
 * Create a Workspace through the modal and wait for its tab (the rebroadcast
 * list is the success signal). `directoryNames` are ticked in the modal.
 */
export async function createWorkspace(
  page: Page,
  name: string,
  directoryNames: string[] = [],
): Promise<void> {
  await getNewWorkspaceButton(page).click();
  const modal = getWorkspaceModal(page);
  await expect(modal).toBeVisible({ timeout: WORKSPACE_TIMEOUT_MS });
  await modal.getByPlaceholder('Workspace name').fill(name);
  for (const directoryName of directoryNames) {
    await getWorkspaceDirectoryRow(modal, directoryName).getByRole('checkbox').check();
  }
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toBeHidden({ timeout: WORKSPACE_TIMEOUT_MS });
  await expect(getWorkspaceTab(page, name)).toBeVisible({ timeout: WORKSPACE_TIMEOUT_MS });
}

/**
 * A tab by its Workspace name, whether or not its accessible name carries a
 * badge suffix ("Team B" or "Team B, 1 need permission"). The name ends at
 * the end of the label or at the comma that starts the suffix, so "Team B"
 * never matches "Team Bravo".
 */
export function getWorkspaceTabByName(page: Page, workspaceName: string): Locator {
  const escaped = workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return getWorkspaceSwitcher(page).getByRole('tab', { name: new RegExp(`^${escaped}(,|$)`) });
}

/** Press a tab (found by Workspace name) and wait until it is the selected one. */
export async function selectWorkspaceTab(page: Page, name: string): Promise<void> {
  const tab = getWorkspaceTabByName(page, name);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}
