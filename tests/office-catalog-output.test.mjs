import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { catalogOutputSchemas as powerPointOutputs } from '../plugins-src/powerpoint/src/catalog-output-schemas.ts';
import { catalogOutputSchemas as wordOutputs } from '../plugins-src/word/src/catalog-output-schemas.ts';

const ok = (result, extra) => ({success:true,...extra,result});
const renamed = {slide_id_update:{'255':'270'}};
const box = {id:'9',name:'Caption',left:39.5,top:402.1,w:167,h:30};
const overlappingBox = {id:'11',name:'Bottom picture',left:40,top:425,w:210,h:120,sizeEstimated:true};
const warning = 'Dimensions assumed because PowerPointApi 1.10 is unavailable.';
const pptExamples = {
  list_slide_shapes:[ok([]),ok([{ref:'255:9',id:'9',name:'Caption',type:'TextBox',left:40,top:402,width:167,height:30}])],
  create_slide_chart:[ok({inserted:'ppt/charts/chart4.xml'},renamed),ok({inserted:'text shapes (big_number)'},renamed)],
  read_chart_style:[ok({chart_count:0,charts:[]}),ok({chart_count:2,charts:[
    {chart_part:'ppt/charts/chart1.xml',style:{form:'pie',series_count:1,fonts:[],font_inherits_theme:true,fills:[],series_fills:[],scheme_colors:[],legend:'right',value_axis:'shown',gridlines:false,has_native_title:false,data_label_position:null,series_color_pattern:'unknown',gap_width:null,unsupported:['pie chart']}},
    {chart_part:'ppt/charts/chart2.xml',style:{form:'column',series_count:1,fonts:['Aptos'],font_inherits_theme:false,fills:['FF0000'],series_fills:['FF0000'],scheme_colors:[],legend:'none',value_axis:'hidden',gridlines:false,has_native_title:false,data_label_position:'outEnd',series_color_pattern:'uniform',gap_width:75,unsupported:[]}},
  ]})],
  edit_built_chart:[ok({chart_part:'ppt/charts/chart2.xml',dropped:[]},renamed)],
  edit_slide_chart:[ok('Read-only chart XML'),{success:true,...renamed}],
  edit_slide_master:[ok(['ppt/slideMasters/slideMaster1.xml']),{success:true,...renamed,
    slide_master_id_update:{'2147483648':'2147483748'},
    slide_master_layouts:[{id:'8',name:'Title and Content'}]},
  {success:true,no_changes_warning:'markDirty() was not called'}],
  edit_slide_xml:[ok(['ppt/slides/slide1.xml']),ok(null),{success:true,no_changes_warning:'markDirty() was not called'},
    {success:true,...renamed},ok({count:4},renamed)],
  duplicate_slide:[{success:true},{success:true,new_slide_id:'270'}],
  verify_slides:[ok({total_slides:0,from_slide:0,to_slide:-1,slides:[],dimensions_assumed_warning:warning}),ok({
    total_slides:2,from_slide:0,to_slide:1,slides:[
      {slideId:'255',shapes:[box,overlappingBox],overflows:[{shape:overlappingBox,bottom:545,slideH:540,overflowBy:5}],
        overlaps:[{shapeA:box,shapeB:overlappingBox,overlapX:166.5,overlapY:7.1}],
        coverage:{bbox_width:210.5,bbox_height:142.9,coverage_ratio:0.1,top_start:402.1,bottom_gap:-5,low_coverage:true},
        inherited_overlaps:[{shape_id:'9',shape_name:'Caption',inherited_id:'2',inherited_name:'Master note',inherited_kind:'text',layer:'master',inherited_box:{left:36,top:426,width:220,height:16},msg:'Caption overlaps inherited text'}],
        contrast_warnings:[{shape_id:'9',shape_name:'Caption',font_color:'#AAAAAA',bg_color:'#FFFFFF',bg_source:'master_background',ratio:2.3,msg:'Low contrast'}],
        text_overflow_warnings:[{shape:'Caption',estTextHeight:38.4,boxHeight:30,innerHeight:24,estLines:2,overflowBy:14.4,runsInto:'Bottom picture',message:'Caption might spill'}],
        small_shape_warnings:[{shape:'Line',width:17,height:2,message:'Line is very small'}]},
      {slideId:'256',shapes:[],overflows:[],overlaps:[],coverage:null},
    ],
  })],
  read_slide_text:[ok('<a:p><a:r><a:t>Caption</a:t></a:r></a:p>'),ok('(connector — no text body. Use execute_office_js to reposition or restyle it.)')],
  edit_slide_text:[{success:true,...renamed}],
  find_and_replace:[ok({dry_run:true,total_replacements:0,slides_modified:0,pairs:[{find:'A',replace:'B',replacements:0}],slides:[],warnings:['No speaker-notes content was found']}),
    ok({dry_run:false,total_replacements:3,slides_modified:1,pairs:[{find:'Alpha',replace:'Beta',replacements:3}],slides:[{slide_id:'255',position:1,replacements:3,
      locations:[{container:'body',replacements:1,shapeId:'9',shapeName:'Caption'},{container:'table',replacements:1,cell:'r0c0'},{container:'notes',replacements:1}]}],
    skipped:[{reason:'field-text',detail:'Auto-generated slide number'}]},renamed)],
  search_icons:[ok([]),ok([{id:'icon-123',description:'Circle',isMono:true,contentTier:null,searchScore:0.75},{id:'icon-124'}])],
  insert_icon:[ok({inserted:true,icon_id:'icon-123',placed_shape:{ref:'270:9',id:'9',left:324,top:234,width:72,height:72}},renamed)],
  copy_image_between_slides:[ok({shape_id:'15'},renamed)],
};

const wordExamples = {
  verify_doc:[ok({styles:{'Heading1':1,'Custom Style':3},lists:[{paraIndex:2,level:0,listString:'1.'}],
    tables:[{tableIndex:0,rowCount:2,cellsPerRow:[2,3],uniform:false}]})],
  read_doc_section:[ok({paragraphStart:5,paragraphEnd:7,paragraphCount:2,text:'[5] First\n[6] Second'}),
    ok({paragraphStart:0,paragraphEnd:2,paragraphCount:2,text:'[0] Heading\n[1] Table cell',formatting:[
      {style:'Title',styleBuiltIn:'Title',alignment:'Centered',lineSpacing:14,leftIndent:6,firstLineIndent:3,font:{name:'Aptos',size:20,bold:true,italic:false,color:'#111111'}},
      {table:{style:'Grid Table',headerRowCount:1}},
    ],truncated:'Section spans 30 paragraphs; showing first 2.'})],
  search_doc_text:[ok({matches:[],total_matches:0,message:'No matches.'}),
    ok({matches:[{snippet:'a uniquely formatted sentence'}],total_matches:1,message:'paragraph_index unavailable on this Word client (WordApi < 1.6).'}),
    ok({matches:[{paragraph_index:8,snippet:'budget for the year'}],total_matches:22,truncated:'Showing first 1 distinct paragraphs of 22 total occurrences.'})],
  collapse_blank_paragraphs:[ok({deleted:0,scanned:3,skipped_with_content:0}),
    ok({deleted:0,scanned:1,skipped_with_content:0,not_removed:1,note:'The final empty paragraph was left in place.'}),
    ok({deleted:1,scanned:12,skipped_with_content:1,tracked:true,note:'Track Changes is on.'}),
    ok({deleted:3,scanned:12,skipped_with_content:0,note:'The deletions were issued; the count was not verified by a read-back.'})],
  edit_doc_text:[ok({replaced:true,paragraph:{text:'New sentence.',styleBuiltIn:'Normal'}}),
    ok({replaced:true},{tracked_change_warning:'Track Changes is on but the edit landed directly.'})],
  edit_doc_list:[ok({items:[{text:'First',isListItem:true,listString:'1.',level:0},{text:'Second',isListItem:true,listString:'2.',level:0}]}),
    ok({items:[{text:'Inserted next to a nested list item',isListItem:true,listString:'a.',level:1}]})],
};

// Like the installed-Loader tests, resolve Harness from the supplied CLI package, not from a profile.
test('every Office output is supported by Harness and validates the runtime success cases', {skip:!process.env.DSH_CLI_PACKAGE}, async()=>{
  const runtime = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const {assertSupportedJsonSchema,validateJsonSchemaValue} = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-tools')).href);
  for (const [outputs,examples] of [[powerPointOutputs,pptExamples],[wordOutputs,wordExamples]]) {
    assert.deepEqual(Object.keys(outputs).sort(),Object.keys(examples).sort());
    for (const [name,values] of Object.entries(examples)) {
      const schema=outputs[name];
      assert.doesNotThrow(()=>assertSupportedJsonSchema(schema),name);
      for (const [index,value] of values.entries())
        assert.deepEqual(validateJsonSchemaValue(schema,value),[],name+' example '+index);
    }
  }
  assert.notEqual(validateJsonSchemaValue(powerPointOutputs.list_slide_shapes,{success:true,shapes:[]}).length,0);
  assert.notEqual(validateJsonSchemaValue(powerPointOutputs.verify_slides,ok([])).length,0);
  assert.notEqual(validateJsonSchemaValue(powerPointOutputs.edit_slide_xml,{success:true,slide_id_update:'270'}).length,0);
  assert.notEqual(validateJsonSchemaValue(wordOutputs.edit_doc_list,ok({items:[{text:'Not attached',isListItem:false,listString:'',level:0}]})).length,0);
});
