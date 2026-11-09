export const name = 'dsh-powerpoint';

/** Dependency-free Standard Schema for deployment-specific connection settings. */
export interface Config {
  catalogRefreshMs: number;
  catalogRetryInitialMs: number;
  catalogRetryMaxMs: number;
  helperUrl: string;
  helperToken: string;
  timeoutMs: number;
  renderBackend: string;
  renderWidth: number;
  renderHeight: number;
  autoHide: boolean;
}

export const Config = {
  '~standard': {
    version: 1, vendor: name, validate(input: Record<string, unknown>) {
      const value = {
        catalogRefreshMs: 300000, catalogRetryInitialMs: 1000, catalogRetryMaxMs: 30000,
        helperUrl: 'http://127.0.0.1:18766', helperToken: '', timeoutMs: 90000, renderBackend: 'officejs', renderWidth: 1280, renderHeight: 720, autoHide: true, ...input
      };
      const issues = [];
      for (const key of ['catalogRefreshMs', 'catalogRetryInitialMs', 'catalogRetryMaxMs'] as const)
        if (!Number.isSafeInteger(value[key]) || value[key] <= 0)
          issues.push({ message: key + ' must be a positive integer', path: [key] });
      if (value.catalogRetryMaxMs < value.catalogRetryInitialMs)
        issues.push({ message: 'catalogRetryMaxMs must be at least catalogRetryInitialMs', path: ['catalogRetryMaxMs'] });
      for (const key of ['backend', 'endpoint', 'targetUrl', 'powershell'])
        if (key in input) issues.push({ message: key + ' is no longer supported; use helperUrl', path: [key] });
      if (!['officejs', 'com'].includes(value.renderBackend)) issues.push({ message: 'renderBackend must be officejs or com', path: ['renderBackend'] });
      if (typeof value.helperToken !== 'string') issues.push({ message: 'helperToken must be a string', path: ['helperToken'] });
      for (const key of ['helperUrl'] as const) {
        try { if (!['http:', 'https:'].includes(new URL(value[key]).protocol)) throw new Error('protocol'); }
        catch (error) { issues.push({ message: key + ' must be an HTTP(S) URL', path: [key] }); }
      }
      for (const key of ['timeoutMs', 'renderWidth', 'renderHeight'] as const) {
        if (!Number.isSafeInteger(value[key]) || value[key] <= 0) issues.push({ message: key + ' must be a positive integer', path: [key] });
      }
      if (typeof value.autoHide !== 'boolean') issues.push({ message: 'autoHide must be boolean', path: ['autoHide'] });

      return issues.length ? { issues } : { value };
    }
  },
};
