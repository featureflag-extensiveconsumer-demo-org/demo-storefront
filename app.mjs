import * as LaunchDarkly from '@launchdarkly/node-server-sdk';
import { batchSize, contextForOneShot, contextForTraffic, isLoadProbe, probeSummary, scheduledEvaluations } from './traffic.mjs';

const repository = 'demo-storefront';
const release = 'v001';
const flags = ["demo-checkout-rollout"];
const profiles = ['production', 'staging', 'test', 'dev'];
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const integer = (value, minimum, maximum, label) => {
  if (!/^\d+$/.test(String(value)) || Number(value) < minimum || Number(value) > maximum) throw new Error(label + ' must be from ' + minimum + ' to ' + maximum + '.');
  return Number(value);
};
const environmentRate = process.env.DEMO_EVALUATIONS_PER_HOUR ? integer(process.env.DEMO_EVALUATIONS_PER_HOUR, 10, 100000, 'Evaluations per hour') : undefined;
const defaults = {
  contextKey: 'demo-user', plan: 'free', region: 'eu', cohort: 'control', cluster: undefined,
  evaluations: 10, profile: process.env.DEMO_ENVIRONMENT || 'production', intervalSeconds: 300,
  evaluationsPerHour: undefined,
  contextPoolSize: process.env.DEMO_CONTEXT_POOL_SIZE ? integer(process.env.DEMO_CONTEXT_POOL_SIZE, 1, 10000, 'Context pool size') : 1000,
  generation: process.env.DEMO_GENERATION_ID || 'untracked', traffic: false
};
let stopRequested = false; let wake; let sdkWarnings = 0; let sdkErrors = 0; let droppedEventWarnings = 0;
const logger = {
  debug: () => {}, info: () => {},
  warn: (message) => { sdkWarnings += 1; const dropped = /drop|capacity|event buffer/i.test(String(message)); if (dropped) droppedEventWarnings += 1; console.warn(JSON.stringify({ type: 'sdk-warning', repository, droppedEventRelated: dropped })); },
  error: () => { sdkErrors += 1; console.error(JSON.stringify({ type: 'sdk-error', repository })); }
};

function optionsFrom(argv) {
  const options = { ...defaults };
  const names = new Map([['--context-key', 'contextKey'], ['--plan', 'plan'], ['--region', 'region'], ['--cohort', 'cohort'], ['--cluster', 'cluster'], ['--evaluations', 'evaluations'], ['--profile', 'profile'], ['--interval-seconds', 'intervalSeconds'], ['--evaluations-per-hour', 'evaluationsPerHour'], ['--context-pool-size', 'contextPoolSize']]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--traffic') { options.traffic = true; continue; }
    const property = names.get(name); const value = argv[index + 1];
    if (!property || value === undefined) throw new Error('Unknown or incomplete argument.');
    if (property === 'intervalSeconds') options[property] = integer(value, 10, 86400, 'Interval');
    else if (property === 'evaluations') options[property] = integer(value, 1, 1000, 'Evaluations');
    else if (property === 'evaluationsPerHour') options[property] = integer(value, 10, 100000, 'Evaluations per hour');
    else if (property === 'contextPoolSize') options[property] = integer(value, 1, 10000, 'Context pool size');
    else { if (!safeIdentifier.test(value)) throw new Error('Arguments must be safe non-empty identifiers.'); options[property] = value; }
    index += 1;
  }
  if (!profiles.includes(options.profile)) throw new Error('Unknown traffic profile.');
  const probe = isLoadProbe(repository, options.profile);
  if (options.evaluationsPerHour !== undefined && (!options.traffic || !probe)) throw new Error('Evaluations per hour is available only for demo-orders Production traffic.');
  if (options.traffic && !probe && environmentRate !== undefined) throw new Error('DEMO_EVALUATIONS_PER_HOUR is available only for demo-orders Production traffic.');
  if (options.traffic && probe) options.evaluationsPerHour ??= environmentRate ?? 1200;
  return options;
}

function wait(ms) {
  return new Promise((resolve) => {
    if (stopRequested) { resolve(); return; }
    let timer; const finish = () => { clearTimeout(timer); if (wake === finish) wake = undefined; resolve(); };
    timer = setTimeout(finish, ms); wake = finish;
  });
}
async function flushOutcome(client) {
  try { await client.flush(); return 'ok'; } catch { return 'failed'; }
}
async function evaluateOne(client, flag, context) { return client.boolVariation(flag, context, false); }
async function ordinaryBatch(client, options, firstIndex, openedAt) {
  const count = batchSize(options.profile, new Date()); let attempted = 0; const perFlag = {}; const clusters = {};
  for (const flag of flags) perFlag[flag] = { true: 0, false: 0 };
  for (let item = 0; item < count && !stopRequested; item += 1) {
    const context = contextForTraffic(repository, options.profile, firstIndex + item, { generation: options.generation, contextPoolSize: options.contextPoolSize });
    for (const flag of flags) { const value = await evaluateOne(client, flag, context); perFlag[flag][String(value)] += 1; attempted += 1; }
    clusters[context.cluster.key] = (clusters[context.cluster.key] || 0) + 1;
  }
  const flush = await flushOutcome(client);
  console.log(JSON.stringify({ type: 'traffic-batch', repository, release, flags, perFlag, profile: options.profile, generation: options.generation, contexts: count, attempted, clusters, flush, connectionMs: openedAt ? Date.now() - openedAt : null }));
  if (flush !== 'ok') throw new Error('SDK flush failed.');
  return count;
}
async function probeTraffic(client, options) {
  const started = Date.now(); let attempted = 0; let errors = 0; let nextSummary = started + 60000;
  const variations = { true: 0, false: 0 }; const clusters = {};
  const emit = async (final = false) => {
    const elapsedMs = Math.max(1, Date.now() - started); const flush = await flushOutcome(client);
    console.log(JSON.stringify(probeSummary({ repository, flag: flags[0], generation: options.generation, requestedRate: options.evaluationsPerHour, attempted, elapsedMs, variations, clusters, contextPoolSize: options.contextPoolSize, errors, sdkWarnings, sdkErrors, droppedEventWarnings, flush, final })));
    if (flush !== 'ok') throw new Error('SDK flush failed.');
  };
  while (!stopRequested) {
    const elapsedMs = Date.now() - started; const target = scheduledEvaluations(options.evaluationsPerHour, elapsedMs);
    while (attempted < target && !stopRequested) {
      const context = contextForTraffic(repository, options.profile, attempted, { generation: options.generation, contextPoolSize: options.contextPoolSize });
      try { const value = await evaluateOne(client, flags[0], context); variations[String(value)] += 1; } catch { errors += 1; }
      clusters[context.cluster.key] = (clusters[context.cluster.key] || 0) + 1; attempted += 1;
    }
    const now = Date.now();
    if (now >= nextSummary) { await emit(); while (nextSummary <= now) nextSummary += 60000; }
    if (!stopRequested) await wait(Math.min(1000, Math.max(1, nextSummary - Date.now())));
  }
  await emit(true);
}

async function main() {
  const sdkKey = process.env.LD_EVALUATION_SDK_KEY;
  if (!sdkKey) throw new Error('LD_EVALUATION_SDK_KEY is required.');
  const options = optionsFrom(process.argv.slice(2)); const probe = options.traffic && isLoadProbe(repository, options.profile);
  const connect = () => LaunchDarkly.init(sdkKey, {
    capacity: 10000, flushInterval: 5, enableEventCompression: true,
    contextKeysCapacity: Math.min(options.contextPoolSize, 10000), contextKeysFlushInterval: 300, logger,
    application: { id: repository, name: repository + ' synthetic evaluator', version: release, versionName: probe ? 'production-load-probe' : 'standard-traffic' }
  });
  const stop = () => { stopRequested = true; if (wake) wake(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (!options.traffic) {
      const client = connect();
      try {
        await client.waitForInitialization({ timeout: 10 });
        for (let index = 0; index < options.evaluations; index += 1) {
          const context = contextForOneShot(repository, options, index);
          for (const flag of flags) console.log(JSON.stringify({ repository, release, flag, value: await evaluateOne(client, flag, context), context }));
        }
      } finally { await client.flush(); await client.close(); }
    } else if (probe) {
      // The bounded rate probe keeps one sustained connection on purpose: its
      // evaluations-per-hour figure only means anything if pacing stays continuous.
      const client = connect();
      try { await client.waitForInitialization({ timeout: 10 }); await probeTraffic(client, options); }
      finally { await client.flush(); await client.close(); }
    } else {
      // Ordinary traffic connects only for the duration of each batch. LaunchDarkly
      // meters average concurrent service connections, so a client held open between
      // batches would cost a full connection while evaluating nothing.
      let index = 0;
      while (!stopRequested) {
        const openedAt = Date.now(); const client = connect();
        try {
          await client.waitForInitialization({ timeout: 10 });
          index += await ordinaryBatch(client, options, index, openedAt);
        } finally { await client.flush(); await client.close(); }
        if (!stopRequested) await wait(options.intervalSeconds * 1000);
      }
    }
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

main().catch(() => { console.error('Error: evaluator failed.'); process.exitCode = 1; });
