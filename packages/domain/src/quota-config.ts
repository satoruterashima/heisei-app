import type { QuotaConfig } from './quota.js';

export type QuotaConfigSource = Record<string, string | undefined>;
const REQUIRED = ['shortWindowMs', 'shortRequestLimit', 'longWindowMs', 'longRequestLimit', 'admissionWindowMs', 'newAdmissionLimit', 'reservationTtlMs', 'maxActiveReservations', 'stateRetentionMs'] as const;

function positive(source: QuotaConfigSource, name: string): number {
  const envName = name.replace(/[A-Z]/gu, (character) => `_${character}`).toUpperCase();
  const raw = source[`HEISEI_QUOTA_${envName}`];
  if (!raw || !/^[1-9][0-9]*$/u.test(raw)) throw new Error(`missing or invalid quota setting: ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`missing or invalid quota setting: ${name}`);
  return value;
}

/** Requires every threshold explicitly; production has no implicit defaults. */
export function quotaConfigFromSource(source: QuotaConfigSource): QuotaConfig {
  return Object.fromEntries(REQUIRED.map((name) => [name, positive(source, name)])) as QuotaConfig;
}
