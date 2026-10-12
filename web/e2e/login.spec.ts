import { test, expect, loginAsDirector } from './auth.fixture';

test.describe('login journey', () => {
  test('shows login page', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'WorkTracker' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByPlaceholder('admin@example.com')).toBeVisible();
  });

  test('rejects bad credentials and shows the error on the login page', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('admin@example.com').fill('nobody@example.com');
    await page.getByPlaceholder('••••••••').fill('WrongPassword123!');
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Regression: this used to assert only that the URL did not change, so a silently
    // failed request (or a hung page) would still pass.
    await expect(page).toHaveURL(/login/);
    await expect(page.getByText(/invalid credentials/i)).toBeVisible({ timeout: 15000 });
  });

  test('director logs in and reaches dashboard', async ({ page }) => {
    await loginAsDirector(page);
    await expect(page.getByRole('navigation')).toBeVisible({ timeout: 15000 });
  });

  test('rejects wrong password for a real account too', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('admin@example.com').fill('e2e-director@example.com');
    await page.getByPlaceholder('••••••••').fill('WrongPassword123!');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page).toHaveURL(/login/);
    await expect(page.getByText(/invalid credentials/i)).toBeVisible({ timeout: 15000 });
  });

  test('keeps the session across a page reload (refresh token)', async ({ directorPage }) => {
    await directorPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(directorPage).toHaveURL(/dashboard/, { timeout: 20000 });
  });

  test('protects a private route when logged out', async ({ page }) => {
    await page.goto('/users');
    // Unauthenticated visitors are redirected to the login screen.
    await expect(page).toHaveURL(/login/, { timeout: 20000 });
  });
});

test.describe('attendance page', () => {
  test('renders the check-in action', async ({ directorPage }) => {
    await directorPage.goto('/attendance');
    await expect(directorPage.getByRole('button', { name: /check in/i }).first()).toBeVisible({ timeout: 15000 });
  });
});
