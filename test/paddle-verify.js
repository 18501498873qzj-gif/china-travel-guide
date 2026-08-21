/**
 * Verify a completed Paddle transaction and subscription
 * 
 * Usage: PADDLE_API_KEY=apikey-xxx node test/paddle-verify.js <transaction_id>
 */

const https = require('https');

const API_KEY = process.env.PADDLE_API_KEY || 'apikey-YOUR_KEY_HERE';

function paddleRequest(method, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.paddle.com',
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const txId = process.argv[2];
  if (!txId) {
    console.error('Usage: node test/paddle-verify.js <transaction_id>');
    process.exit(1);
  }

  console.log(`Verifying transaction: ${txId}`);

  // 1. Get transaction
  const tx = await paddleRequest('GET', `/transactions/${txId}`);
  console.log('\n─── Transaction ───');
  if (tx.data?.data) {
    const t = tx.data.data;
    console.log(`  ID: ${t.id}`);
    console.log(`  Status: ${t.status} ${t.status === 'completed' ? '✅' : '❌'}`);
    console.log(`  Amount: ${t.amount?.amount ? (t.amount.amount / 100).toFixed(2) + ' ' + t.amount.currency : 'N/A'}`);
    console.log(`  Customer: ${t.customer?.email || 'N/A'}`);
    console.log(`  Custom Data: ${t.custom_data ? JSON.stringify(t.custom_data).substring(0, 100) : 'none'}`);
    console.log(`  Subscription: ${t.subscription_id || 'none (one-time)'}`);
    console.log(`  Completed: ${t.completed_at || 'N/A'}`);
  }

  // 2. If subscription, get it
  if (tx.data?.data?.subscription_id) {
    const subId = tx.data.data.subscription_id;
    const sub = await paddleRequest('GET', `/subscriptions/${subId}`);
    console.log('\n─── Subscription ───');
    if (sub.data?.data) {
      const s = sub.data.data;
      console.log(`  ID: ${s.id}`);
      console.log(`  Status: ${s.status}`);
      console.log(`  Plan: ${s.plan_id}`);
      console.log(`  Current Period: ${s.current_billing_period?.start} → ${s.current_billing_period?.end}`);
      console.log(`  Scheduled Change: ${s.scheduled_change ? JSON.stringify(s.scheduled_change) : 'none'}`);
      console.log(`  Canceled At: ${s.canceled_at || 'active'}`);
    }
  }

  // 3. List webhook deliveries for this transaction
  console.log('\n─── Recent Webhook Deliveries ───');
  const logs = await paddleRequest('GET', '/notification-settings');
  if (logs.data?.data) {
    for (const n of logs.data.data) {
      console.log(`  ${n.configuration?.url || 'N/A'} — events: ${(n.events || []).join(', ')} — status: ${n.status}`);
    }
  }

  console.log('\n✅ Verification complete.');
}

main().catch(console.error);