const profiles = {
  production: { enterprise: 10, beta: 15, legacy: 8, busy: 100, quiet: 40 },
  staging: { enterprise: 20, beta: 30, legacy: 20, busy: 30, quiet: 12 },
  test: { enterprise: 30, beta: 35, legacy: 30, busy: 10, quiet: 4 },
  dev: { enterprise: 15, beta: 25, legacy: 12, busy: 2, quiet: 1 }
};
export const clusters = {
  production: [
    { key: 'prod-eu-west-01', name: 'Production EU West 01', environment: 'production', region: 'eu-west', ordinal: 1, releaseRing: 'stable', weight: 50 },
    { key: 'prod-emea-central-04', name: 'Production EMEA Central 04', environment: 'production', region: 'emea-central', ordinal: 4, releaseRing: 'canary', weight: 30 },
    { key: 'prod-sa-east-02', name: 'Production South America East 02', environment: 'production', region: 'sa-east', ordinal: 2, releaseRing: 'stable', weight: 20 }
  ],
  staging: [
    { key: 'stg-eu-central-01', name: 'Staging EU Central 01', environment: 'staging', region: 'eu-central', ordinal: 1, releaseRing: 'canary', weight: 60 },
    { key: 'stg-eu-central-02', name: 'Staging EU Central 02', environment: 'staging', region: 'eu-central', ordinal: 2, releaseRing: 'stable', weight: 40 }
  ],
  test: [
    { key: 'test-eu-central-01', name: 'Test EU Central 01', environment: 'test', region: 'eu-central', ordinal: 1, releaseRing: 'canary', weight: 75 },
    { key: 'test-eu-central-02', name: 'Test EU Central 02', environment: 'test', region: 'eu-central', ordinal: 2, releaseRing: 'stable', weight: 25 }
  ],
  dev: [{ key: 'dev-local-01', name: 'Development Local 01', environment: 'dev', region: 'local', ordinal: 1, releaseRing: 'stable', weight: 100 }]
};
const offsets = { 'demo-orders': 11, 'demo-storefront': 43, 'demo-profile': 71 };
const clusterKey = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isLoadProbe(repository, profile) { return repository === 'demo-orders' && profile === 'production'; }
export function clusterFor(repository, profile, index) {
  const choices = clusters[profile];
  if (!choices || !Object.hasOwn(offsets, repository) || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid cluster input.');
  const bucket = (index * 17 + offsets[repository]) % 100; let boundary = 0;
  const selected = choices.find((item) => { boundary += item.weight; return bucket < boundary; });
  if (!selected || !clusterKey.test(selected.key)) throw new Error('Invalid cluster configuration.');
  const { weight, ...context } = selected; return context;
}
function multiContext(repository, user, cluster, generation) {
  return { kind: 'multi', user, service: { key: repository, name: repository }, cluster: { ...cluster, generation } };
}
export function contextForOneShot(repository, options, index) {
  if (!Object.hasOwn(offsets, repository) || !Number.isSafeInteger(options?.evaluations) || options.evaluations < 1 || !Number.isSafeInteger(index) || index < 0 || index >= options.evaluations) throw new Error('Invalid one-shot input.');
  const choices = clusters[options.profile]; const selected = choices?.find((item) => item.key === (options.cluster || choices[0].key));
  if (!selected) throw new Error('Cluster does not belong to the selected environment.');
  const { weight, ...cluster } = selected;
  const key = options.evaluations === 1 ? options.contextKey : options.contextKey + '-' + String(index + 1).padStart(3, '0');
  return multiContext(repository, { key, plan: options.plan, region: options.region, cohort: options.cohort }, cluster, options.generation || 'untracked');
}
export function contextForTraffic(repository, profile, index, options = {}) {
  const settings = profiles[profile]; const contextPoolSize = options.contextPoolSize ?? 10000;
  if (!settings || !Object.hasOwn(offsets, repository) || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(contextPoolSize) || contextPoolSize < 1 || contextPoolSize > 10000) throw new Error('Invalid traffic input.');
  const bucket = (index * 37 + offsets[repository]) % 100;
  const user = { key: [repository, profile, index % contextPoolSize].join('-'), plan: 'free', region: 'eu', cohort: 'control' };
  if (repository === 'demo-profile') { if (bucket < settings.legacy) user.region = 'legacy'; }
  else if (bucket < settings.enterprise) user.plan = 'enterprise';
  else if (bucket < settings.enterprise + settings.beta) user.cohort = 'checkout-beta';
  return multiContext(repository, user, clusterFor(repository, profile, index), options.generation || 'untracked');
}
export function scheduledEvaluations(rate, elapsedMs) {
  if (!Number.isSafeInteger(rate) || rate < 10 || rate > 100000 || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw new Error('Invalid probe schedule input.');
  return Math.floor((rate * elapsedMs) / 3600000);
}
export function probeSummary(input) {
  const elapsedHours = input.elapsedMs / 3600000;
  return { type: 'load-probe-summary', repository: input.repository, service: input.repository, flag: input.flag, profile: 'production', generation: input.generation, requestedEvaluationsPerHour: input.requestedRate, attempted: input.attempted, elapsedSeconds: Number((input.elapsedMs / 1000).toFixed(3)), achievedEvaluationsPerHour: elapsedHours > 0 ? Number((input.attempted / elapsedHours).toFixed(2)) : 0, variations: input.variations, clusters: input.clusters, contextPoolSize: input.contextPoolSize, errors: input.errors, sdkWarnings: input.sdkWarnings || 0, sdkErrors: input.sdkErrors || 0, droppedEventWarnings: input.droppedEventWarnings || 0, flush: input.flush, final: Boolean(input.final) };
}
export function batchSize(profile, at) {
  const settings = profiles[profile];
  if (!settings || !(at instanceof Date) || Number.isNaN(at.valueOf())) throw new Error('Invalid traffic schedule input.');
  const day = at.getUTCDay(); const hour = at.getUTCHours(); const businessHours = day >= 1 && day <= 5 && hour >= 7 && hour < 19;
  return businessHours ? settings.busy : settings.quiet;
}
