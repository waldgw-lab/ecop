import { runCuratedIngest } from './server/curatedIngest';
import { clusterCuratedLane } from './server/curatedCluster';
(async () => {
  const ing = await runCuratedIngest();
  console.log('INGEST', JSON.stringify(ing));
  const cl = await clusterCuratedLane();
  console.log('CLUSTER', JSON.stringify(cl));
  process.exit(0);
})().catch(e => { console.error('SMOKE ERR', e); process.exit(1); });
