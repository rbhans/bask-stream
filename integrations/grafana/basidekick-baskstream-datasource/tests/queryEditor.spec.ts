import { test, expect } from '@grafana/plugin-e2e';

test('smoke: should render query editor', async ({ panelEditPage, readProvisionedDataSource }) => {
  const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
  await panelEditPage.datasource.set(ds.name);
  const queryRow = panelEditPage.getQueryEditorRow('A');
  await expect(queryRow.getByRole('combobox', { name: 'Mode' })).toBeVisible();
  await expect(queryRow.getByRole('textbox', { name: 'ORD' })).toBeVisible();
  await expect(queryRow.locator('#query-editor-search')).toBeVisible();
  await expect(queryRow.locator('#query-editor-browse-base')).toBeVisible();
});

test('snapshot mode should show point list input', async ({ page, panelEditPage, readProvisionedDataSource }) => {
  const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
  await panelEditPage.datasource.set(ds.name);
  const queryRow = panelEditPage.getQueryEditorRow('A');
  await queryRow.getByRole('combobox', { name: 'Mode' }).click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(queryRow.getByRole('textbox', { name: 'Point ORDs' })).toBeVisible();
});
