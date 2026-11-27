import { array, boolean, integer, nullable, number, openRecord, record, string, success, trueValue } from '../../shared/catalog-output-schema.ts';
import type { Schema } from '../../shared/types.ts';

const slideIdUpdate = {
  type: 'object', additionalProperties: true,
  description: 'Old slide ID → new slide ID string.',
} as const;
const writeback = { slide_id_update: slideIdUpdate };
const callbackOutput = {
  ...writeback,
  no_changes_warning: string,
  result: {},
};

const placement = { ref: string, id: string, left: integer, top: integer, width: integer, height: integer };
const box = record({ id: string, name: string, left: number, top: number, w: number, h: number }, {
  isTable: trueValue, sizeEstimated: trueValue,
});
const shapeRef = { ...openRecord({ id: string, name: string }), description: 'Geometry is in shapes.' };
const verifiedSlide = record({
  slideId: string,
  shapes: array(box),
  overflows: array(openRecord({ shape: shapeRef, overflowBy: number })),
  overlaps: array(openRecord({ shapeA: shapeRef, shapeB: shapeRef, overlapX: number, overlapY: number }, {
    bothHaveText: trueValue, isContainment: trueValue,
  })),
  coverage: nullable(openRecord({ coverage_ratio: nullable(number) })),
}, {
  inherited_overlaps: array(openRecord({ shape_id: string, msg: string })),
  contrast_warnings: array(openRecord({ shape_id: string, ratio: number, msg: string }, {
    bg_shape_id: string, bg_source: string,
  })),
  text_overflow_warnings: array(openRecord({ shape: string, overflowBy: number, message: string })),
  small_shape_warnings: array(openRecord({ shape: string, message: string })),
});

const chartStyle = openRecord({
  form: string, fonts: array(string), fills: array(string), legend: string, value_axis: string, gridlines: boolean,
  unsupported: array(string),
});
const replacementReport = record({
  dry_run: boolean, total_replacements: integer, slides_modified: integer,
  pairs: array(openRecord({ replacements: integer })),
  slides: array(record({
    slide_id: string, position: integer, replacements: integer,
    locations: array(record({ container: { type: 'string', enum: ['body', 'table', 'notes'] }, replacements: integer }, {
      shapeId: string, shapeName: string, cell: string,
    })),
  })),
}, { skipped: array(record({ reason: string, detail: string })), warnings: array(string) });

/** Successful envelopes emitted by the PowerPoint client runtime. */
export const catalogOutputSchemas: Readonly<Partial<Record<string, Schema>>> = {
  list_slide_shapes: success(array(record({ ...placement, name: string, type: string }))),
  create_slide_chart: success(record({ inserted: string }), writeback),
  read_chart_style: success(record({ chart_count: integer, charts: array(record({ chart_part: string, style: chartStyle })) })),
  edit_built_chart: success(record({ chart_part: string, dropped: array(string) }), writeback),
  edit_slide_chart: record({ success: trueValue }, callbackOutput),
  edit_slide_master: record({ success: trueValue }, {
    ...callbackOutput,
    slide_master_id_update: {
      type: 'object', additionalProperties: true,
      description: 'Old master ID → new master ID string.',
    },
    slide_master_layouts: array(record({ id: string, name: string })),
  }),
  edit_slide_xml: record({ success: trueValue }, callbackOutput),
  duplicate_slide: record({ success: trueValue }, {
    new_slide_id: { type: 'string', description: 'ID of the new copy; absent when it could not be determined, in which case read powerpoint_deck_info.' },
  }),
  verify_slides: success(record({
    slides: array(verifiedSlide), total_slides: integer,
    from_slide: { ...integer, description: 'First index in the checked range, inclusive and one-based.' },
    to_slide: { ...integer, description: 'Last index in the checked range, inclusive and one-based; 0 for an empty deck.' },
  }, { dimensions_assumed_warning: string })),
  read_slide_text: success(string),
  edit_slide_text: record({ success: trueValue }, writeback),
  find_and_replace: success(replacementReport, writeback),
  search_icons: success(array(openRecord({}, {
    id: { description: 'Use string IDs with insert_icon.' }, description: {},
  }))),
  insert_icon: success(record({ inserted: trueValue, icon_id: string }, {
    placed_shape: openRecord({ ref: string, id: string }),
  }), writeback),
  copy_image_between_slides: success(record({ shape_id: string }), writeback),
};
