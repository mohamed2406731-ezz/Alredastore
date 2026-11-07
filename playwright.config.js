const { defineConfig } = require('@playwright/test');
const { z } = require('zod');
const port = z.coerce.number().int().min(1024).max(65535).default(3100).parse(process.env.PLAYWRIGHT_PORT);
const origin = `http://127.0.0.1:${port}`;
module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  use: { baseURL: origin, channel: 'chrome', screenshot: 'only-on-failure' },
  webServer: { command: 'node src/server.js', url: origin, reuseExistingServer: false,
    // Synthetic contact configuration; tests never message a real business.
    env: { PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', WHATSAPP_PHONE: '15550100100',
      DATABASE_URL: '', DIRECT_URL: '', DATABASE_URL_UNPOOLED: '', DATABASE_REQUIRED: 'false',
      CHECKOUT_ENABLED: 'false', CHECKOUT_ORIGIN: '', CHECKOUT_SHIPPING_RATES: '{}',
      CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '' } },
});
