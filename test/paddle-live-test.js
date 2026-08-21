/**
 * Paddle Live End-to-End Test Script
 * 
 * Run this with your Paddle Live API Key:
 *   PADDLE_API_KEY=apikey-xxx node test/paddle-live-test.js
 * 
 * This script:
 * 1. Verifies domain is approved in Paddle
 * 2. Creates a 100% off discount code
 * 3. Lists products and prices
 * 4. Verifies webhook endpoint is reachable
 */

const https = require('https');

const API_KEY = process.env.PADDLE_API_KEY || 'apikey-YOUR_KEY_HERE';
const BASE_URL = 'api.paddle.com';

function paddleRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const url = process.env.APP_URL || 'https://china-travel-guide-mozq.onrender.com';
  
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Paddle Live Integration Test           ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`API Key: ${API_KEY.substring(0, 10)}...${API_KEY.substring(API_KEY.length - 4)}`);
  console.log(`App URL: ${url}`);
  console.log('');

  // 1. List checkout domains
  console.log('─── 1. Checkout Domains ───');
  try {
    const r = await paddleRequest('GET', '/checkout-domains');
    console.log(`Status: ${r.status}`);
    if (r.data?.data) {
      for (const d of r.data.data) {
        console.log(`  ${d.domain} → status: ${d.status}`);
        if (d.domain.includes('onrender')) {
          if (d.status === 'approved') {
            console.log('  ✅ Your domain is APPROVED');
          } else {
            console.log(`  ❌ Domain status is "${d.status}", must be "approved" for checkout to work`);
          }
        }
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Could not fetch domains: ${e.message}`);
  }
  console.log('');

  // 2. List products
  console.log('─── 2. Products & Prices ───');
  try {
    const r = await paddleRequest('GET', '/products');
    console.log(`Status: ${r.status}`);
    if (r.data?.data) {
      for (const p of r.data.data) {
        console.log(`  Product: ${p.id} — ${p.name} (status: ${p.status})`);
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Could not fetch products: ${e.message}`);
  }

  try {
    const r = await paddleRequest('GET', '/prices');
    console.log(`Status: ${r.status}`);
    if (r.data?.data) {
      for (const p of r.data.data) {
        const amount = p.unit_price?.amount ? (p.unit_price.amount / 100).toFixed(2) : 'N/A';
        console.log(`  Price: ${p.id} — ${p.name || 'unnamed'} — ${amount} ${p.currency} (${p.billing_cycle || 'one-time'})`);
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Could not fetch prices: ${e.message}`);
  }
  console.log('');

  // 3. Create 100% discount
  console.log('─── 3. Create 100% Discount ───');
  try {
    const r = await paddleRequest('POST', '/discounts', {
      name: 'Zero-cost test',
      description: 'End-to-end live test discount — will be archived after use',
      type: 'percentage',
      amount: '100',
      code: 'TEST100',
      restrict_to: [],
      expires_at: null,
      recurring: false,
      usage_limit: 1,
      enable_for_checkout: true,
    });
    console.log(`Status: ${r.status}`);
    if (r.data?.data) {
      console.log(`  ✅ Discount created: code=${r.data.data.code}, id=${r.data.data.id}`);
      console.log(`  Apply at checkout with code: TEST100`);
    } else if (r.data?.error) {
      console.log(`  ❌ Error: ${JSON.stringify(r.data.error)}`);
    }
  } catch (e) {
    console.log(`  ⚠️  Could not create discount: ${e.message}`);
  }
  console.log('');

  // 4. Verify webhook endpoint
  console.log('─── 4. Webhook Endpoint ───');
  try {
    const r = await paddleRequest('GET', '/notifications');
    console.log(`Status: ${r.status}`);
    if (r.data?.data) {
      const webhooks = r.data.data.filter(n => n.configuration?.url?.includes('/webhook'));
      if (webhooks.length > 0) {
        for (const w of webhooks) {
          console.log(`  ✅ Webhook: ${w.configuration?.url} (status: ${w.status})`);
        }
      } else {
        console.log('  ⚠️  No /webhook endpoint configured. Add it in Paddle Dashboard → Developer Tools → Notifications');
        console.log(`  URL to add: ${url}/webhook`);
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Could not fetch webhooks: ${e.message}`);
    console.log(`  Manual step: Add ${url}/webhook in Paddle Dashboard → Notifications → subscribe to transaction.completed`);
  }
  console.log('');

  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Next Steps                              ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('1. Confirm business verification is PASSED in Paddle dashboard');
  console.log('2. Confirm domain is APPROVED (checkout won\'t open otherwise)');
  console.log('3. If webhook not configured, add:');
  console.log(`   URL: ${url}/webhook`);
  console.log('   Event: transaction.completed');
  console.log('4. Run a test checkout:');
  console.log(`   → Open ${url}/order`);
  console.log('   → Fill form, click Buy Now');
  console.log('   → Apply discount code: TEST100');
  console.log('   → Complete with real card ($0 charged)');
  console.log('5. After purchase, run: node test/paddle-verify.js <transaction_id>');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});