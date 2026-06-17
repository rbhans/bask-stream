import { test, expect } from '@grafana/plugin-e2e';

test('smoke: should render config editor', async ({ createDataSourceConfigPage, readProvisionedDataSource, page }) => {
  const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
  await createDataSourceConfigPage({ type: ds.type });
  await expect(page.getByLabel('Station URL')).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'TLS mode' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Allow plain HTTP' })).toBeVisible();
  await expect(page.getByLabel('Max history records')).toBeVisible();
  await expect(page.getByLabel('Max point ORDs')).toBeVisible();
  await expect(page.getByLabel('Max live lease')).toBeVisible();
});
