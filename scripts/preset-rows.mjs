import YAML from 'yaml';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireValid = (condition, message) => {
  if (!condition) throw new Error('presetRows: ' + message);
};

export function validatePresetRows(overrides) {
  if (overrides === undefined) return;
  requireValid(object(overrides), 'expected an object');
  requireValid(Object.keys(overrides).every(key => ['all', 'presets'].includes(key)), 'only all and presets are supported');
  const validateRows = rows => {
    requireValid(object(rows), 'row selectors must be an object');
    for (const [selector, value] of Object.entries(rows)) {
      requireValid(selector.split('/').every(part => part.length > 0), 'empty row id or group path');
      requireValid(object(value) && Object.keys(value).length === 1 && typeof value.disabled === 'boolean',
        'each row override must contain only disabled: boolean');
    }
  };
  if (overrides.all !== undefined) validateRows(overrides.all);
  if (overrides.presets !== undefined) {
    requireValid(object(overrides.presets), 'presets must be an object keyed by preset config.id');
    for (const rows of Object.values(overrides.presets)) validateRows(rows);
  }
}

// Edit YAML nodes rather than round-tripping expression marker objects through JSON.
export function applyPresetRowOverrides(text, overrides) {
  validatePresetRows(overrides);
  if (overrides === undefined || (!Object.keys(overrides.all ?? {}).length && !Object.keys(overrides.presets ?? {}).length)) return text;
  const document = YAML.parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: expression => expression }],
  });
  requireValid(!document.errors.length && !document.warnings.length && YAML.isSeq(document.contents), 'invalid patch YAML');
  const entries = document.contents.items.flatMap(row => {
    const insert = row.get('insert');
    return YAML.isSeq(insert) ? insert.items : [row];
  });
  const presets = entries.filter(row => row.get('name') === '@deepseek-ai/dsh-agent-preset');
  const byId = new Map();
  for (const preset of presets) {
    const id = preset.getIn(['config', 'id']);
    requireValid(typeof id === 'string' && !byId.has(id), 'missing or duplicate preset config.id');
    byId.set(id, preset);
  }
  for (const id of Object.keys(overrides.presets ?? {})) requireValid(byId.has(id), 'unknown preset: ' + id);
  requireValid(byId.size > 0, 'no presets to override');
  for (const [id, preset] of byId) {
    const rows = [];
    const visit = (children, parents = []) => {
      requireValid(YAML.isSeq(children), 'expected plugin rows in preset ' + id);
      for (const row of children.items) {
        requireValid(YAML.isMap(row) && typeof row.get('id') === 'string', 'plugin row needs an id in preset ' + id);
        const path = [...parents, row.get('id')];
        rows.push({ row, path: path.join('/') });
        if (row.get('group') === true || row.get('name') === 'cordis:group') visit(row.get('config', true), path);
      }
    };
    visit(preset.getIn(['config', 'plugins'], true));
    const resolve = selectors => {
      const selected = new Map();
      for (const [selector, value] of Object.entries(selectors ?? {})) {
        const matches = rows.filter(({ row, path }) => selector.includes('/') ? path === selector : row.get('id') === selector);
        requireValid(matches.length === 1, (matches.length ? 'ambiguous' : 'unmatched') + ' row selector ' + selector + ' in preset ' + id);
        requireValid(!selected.has(matches[0].row), 'multiple selectors target the same row in preset ' + id);
        selected.set(matches[0].row, value.disabled);
      }
      return selected;
    };
    const selected = resolve(overrides.all);
    // Specific selectors win even when they use a different spelling of the same path.
    for (const [row, disabled] of resolve(overrides.presets?.[id])) selected.set(row, disabled);
    for (const [row, disabled] of selected) row.set('disabled', document.createNode(disabled));
  }
  return document.toString();
}
