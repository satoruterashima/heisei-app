import { ReportCryptoError, type ReportKeyProvider } from './report-security.js';

export interface SecretValueSource {
  get(name: string): Promise<string | undefined> | string | undefined;
}

export type SecretReportKeyProviderOptions = {
  source: SecretValueSource;
  encryptionKeyVersions: readonly string[];
  fingerprintKeyVersions: readonly string[];
};

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new ReportCryptoError();
  try {
    const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ReportCryptoError();
  }
}

function validateVersions(versions: readonly string[]): readonly string[] {
  const unique = [...new Set(versions)];
  if (unique.length === 0 || unique.some((version) => !VERSION.test(version))) throw new ReportCryptoError();
  return unique;
}

/** Production-shaped provider for Workers Secret bindings; no fallback or logging. */
export class SecretReportKeyProvider implements ReportKeyProvider {
  readonly encryptionKeyVersions: readonly string[];
  readonly fingerprintKeyVersions: readonly string[];

  constructor(private readonly options: SecretReportKeyProviderOptions) {
    this.encryptionKeyVersions = validateVersions(options.encryptionKeyVersions);
    this.fingerprintKeyVersions = validateVersions(options.fingerprintKeyVersions);
  }

  async getEncryptionKey(version: string): Promise<CryptoKey> {
    if (!this.encryptionKeyVersions.includes(version)) throw new ReportCryptoError();
    return this.importKey('encryption', version, 'AES-GCM');
  }

  async getFingerprintKey(version: string): Promise<CryptoKey> {
    if (!this.fingerprintKeyVersions.includes(version)) throw new ReportCryptoError();
    return this.importKey('fingerprint', version, 'HMAC');
  }

  private async importKey(kind: 'encryption' | 'fingerprint', version: string, algorithm: 'AES-GCM' | 'HMAC'): Promise<CryptoKey> {
    const value = await this.options.source.get(`HEISEI_REPORT_${kind.toUpperCase()}_KEY_${version}`);
    if (!value) throw new ReportCryptoError();
    const bytes = decodeBase64Url(value);
    if (bytes.byteLength !== 32) throw new ReportCryptoError();
    try {
      return await crypto.subtle.importKey('raw', bytes as unknown as BufferSource,
        algorithm === 'AES-GCM' ? { name: 'AES-GCM', length: 256 } : { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false, algorithm === 'AES-GCM' ? ['encrypt', 'decrypt'] : ['sign']);
    } catch {
      throw new ReportCryptoError();
    }
  }
}
