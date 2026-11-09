import type { CatalogTool } from '../../shared/catalog.ts';
import { normalizeSchema, qualifyDescriptions } from '../../shared/catalog-schema.ts';
import type { Schema } from '../../shared/types.ts';

const slideIdDescription = 'Current slide ID from powerpoint_deck_info.slideIds, in presentation order, or powerpoint_verify_slides. Do not use a page number as an ID. After a writeback, use the returned slide_id_update before editing again.';
const descriptions: Record<string, string> = {
  edit_slide_master: 'Edit the master and layouts associated with the FIRST slide via OOXML. Applies layout migration only to pages using that original master; preserves other masters. The callback receives the first slide\'s exported package and its master/layout/theme dependencies, not an arbitrary master ID or the complete deck. Call markDirty() only after changing files; use returned ID mappings after replacement.',
};
const suffixes: Record<string, string> = {
  edit_slide_xml: ' Read-only callbacks that do not call markDirty() never import a replacement. DOMParser and XMLSerializer are available. Modified writebacks return slide_id_update; use the new ID in subsequent calls.',
};
const fieldDescriptions: Record<string, Record<string, string>> = {
  edit_slide_master: {
    code: 'The JSZip archive includes the first slide and its associated master/layout/theme parts. DOMParser, XMLSerializer and escapeXml(text) are available. Call markDirty() after changing files.',
  },
};

/** DSH-owned references and writeback guidance; runtime prose comes from the catalog. */
export function catalogDefinitions(tools: CatalogTool[]) {
  const describe = qualifyDescriptions('powerpoint_', [...tools.map(tool => tool.clientName), 'execute_office_js']);
  return tools.map(tool => {
    const parameters = normalizeSchema(tool.inputSchema, describe);
    for (const [key, field] of Object.entries(parameters.properties ?? {})) {
      if (['slide_id', 'from_slide_id', 'to_slide_id'].includes(key)) field.description = slideIdDescription;
      if (key === 'slide_ids' && field.items) field.items.description = slideIdDescription;
      const replacement = fieldDescriptions[tool.clientName]?.[key];
      if (replacement) field.description = (field.description?.split('. ')[0] ?? '') + '. ' + replacement;
    }
    let description = descriptions[tool.clientName] ?? describe(tool.description);
    if (tool.clientName === 'edit_slide_text') description = description.replace(/See the .*?system prompt for editing rules\./,
      'Preserve existing text, paragraph styles and formatting outside the requested change.');
    description += suffixes[tool.clientName] ?? '';
    return { ...tool, description, inputSchema: parameters as Schema & { type: 'object' } };
  });
}
