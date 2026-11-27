export const name = 'dsh-word';

export interface Config {
  catalogRefreshMs: number;
  catalogRetryInitialMs: number;
  catalogRetryMaxMs: number;
  helperUrl: string;
  helperToken: string;
  timeoutMs: number;
  autoHide: boolean;
  renderLongEdge: number;
}

/** Deployment settings; no package or bundle parsing occurs during tool calls. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: name,
    validate(input: Record<string, unknown>) {
      const value = {
        catalogRefreshMs: 300000, catalogRetryInitialMs: 1000, catalogRetryMaxMs: 30000,
        helperUrl: 'http://127.0.0.1:18770',
        helperToken: '',
        timeoutMs: 90000,
        autoHide: true,
        renderLongEdge: 1800,
        ...input,
      };
      const issues = [];
      for (const key of ['catalogRefreshMs', 'catalogRetryInitialMs', 'catalogRetryMaxMs'] as const)
        if (!Number.isSafeInteger(value[key]) || value[key] <= 0)
          issues.push({ message: key + ' must be a positive integer', path: [key] });
      if (value.catalogRetryMaxMs < value.catalogRetryInitialMs)
        issues.push({ message: 'catalogRetryMaxMs must be at least catalogRetryInitialMs', path: ['catalogRetryMaxMs'] });
      try {
        if (!['http:', 'https:'].includes(new URL(value.helperUrl).protocol)) throw new Error('protocol');
      } catch (error) {
        issues.push({ message: 'helperUrl must be an HTTP(S) URL', path: ['helperUrl'] });
      }
      if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0)
        issues.push({ message: 'timeoutMs must be a positive integer', path: ['timeoutMs'] });
      // The helper's wordRender() in office_cdp_helper.mjs accepts longEdge from 1 to 16384.
      if (!Number.isInteger(value.renderLongEdge) || value.renderLongEdge < 1 || value.renderLongEdge > 16384)
        issues.push({ message: 'renderLongEdge must be an integer from 1 to 16384', path: ['renderLongEdge'] });
      if (typeof value.helperToken !== 'string')
        issues.push({ message: 'helperToken must be a string', path: ['helperToken'] });
      if (typeof value.autoHide !== 'boolean')
        issues.push({ message: 'autoHide must be boolean', path: ['autoHide'] });
      return issues.length ? { issues } : { value };
    },
  },
};
