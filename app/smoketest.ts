import { DriverBuilder } from './driverBuilder';

async function main() {
  const builder = new DriverBuilder({
    headless: true, // pas de serveur X ici ; passe à false pour observer le navigateur
    device: 'iPhone 15',
    keepProfile: false,
    maxRetries: 2,
  });

  const { context, page, profileDir } = await builder.build();
  console.log('Profil lancé dans :', profileDir);

  try {
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    console.log('Titre de la page :', await page.title());
    console.log('User-Agent effectif :', await page.evaluate(() => navigator.userAgent));
    console.log('navigator.webdriver :', await page.evaluate(() => navigator.webdriver));
  } finally {
    await DriverBuilder.quit(context);
  }

  console.log('Smoke test OK ✅');
}

main().catch((err) => {
  console.error('Smoke test KO ❌', err);
  process.exit(1);
});
