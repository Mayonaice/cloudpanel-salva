if (!process.env.CRON_SECRET) throw new Error('CRON_SECRET is required');
const response = await fetch('http://127.0.0.1:8791/api/internal/jobs/run', {
  method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  signal: AbortSignal.timeout(65000),
});
if (!response.ok) throw new Error(`Cloud jobs HTTP ${response.status}`);
console.log('Cloud maintenance job invocation completed.');
