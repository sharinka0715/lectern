import assert from 'node:assert/strict';
import test from 'node:test';
import { ZipFile } from 'yazl';
import { extractOfficeText } from '../src/backend/office-preview';

async function archive(entries: Record<string,string>) {
  const file = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve,reject) => {
    file.outputStream.on('data', chunk=>chunks.push(chunk)).once('error',reject).once('end',()=>resolve(Buffer.concat(chunks)));
  });
  for (const [name,content] of Object.entries(entries)) file.addBuffer(Buffer.from(content),name);
  file.end();
  return done;
}
test('Word paragraphs, runs, tabs and Unicode survive text preview; external entities are rejected', async () => {
  const doc = '<w:document xmlns:w="test"><w:p><w:r><w:t>A &amp; B</w:t></w:r><w:tab/><w:r><w:t>中文</w:t></w:r></w:p><w:p><w:t>fin</w:t></w:p></w:document>';
  const bytes = await archive({'word/document.xml':doc,'word/media/image.png':'ignored'});
  assert.deepEqual(await extractOfficeText('a.DOCX',bytes),{text:'A & B\t中文\nfin',truncated:false});
  await assert.rejects(extractOfficeText('a.docx',await archive({'word/document.xml':'<!DOCTYPE x [<!ENTITY a "abc">]><x/>'})),/文档类型/);
});
test('presentation text follows declared slide order, skipping external and unreferenced slides', async () => {
  const body=(t:string)=>`<p><t>${t}</t></p>`;
  const bytes = await archive({
    'ppt/presentation.xml':'<p><sldId r:id="b"/><sldId r:id="a"/><sldId r:id="remote"/></p>',
    'ppt/_rels/presentation.xml.rels':'<r><Relationship Id="a" Target="slides/slide2.xml"/><Relationship Id="b" Target="/ppt/slides/slide7.xml"/><Relationship Id="remote" TargetMode="External" Target="https://example.invalid/a"/></r>',
    'ppt/slides/slide2.xml':body('second'), 'ppt/slides/slide7.xml':body('first'),'ppt/slides/slide9.xml':body('orphan')
  });
  const {text}=await extractOfficeText('a.pptx',bytes);
  assert.match(text,/第 1 页\nfirst\n\n第 2 页\nsecond/); assert.doesNotMatch(text,/orphan|remote/);
});
test('workbook preview follows sheet names and sparse addresses with shared, inline, formula and boolean cells', async () => {
  const bytes=await archive({
    'xl/workbook.xml':'<b><sheet name="明细" r:id="r3"/></b>',
    'xl/_rels/workbook.xml.rels':'<r><Relationship Id="r3" Target="worksheets/sheet3.xml"/></r>',
    'xl/sharedStrings.xml':'<sst><si><r><t>hello</t></r><r><t>!</t></r></si></sst>',
    'xl/worksheets/sheet3.xml':'<sheet><row><c r="B1" t="s"><v>0</v></c><c r="F1" t="inlineStr"><is><t>二</t></is></c></row><row><c r="A9" t="b"><v>1</v></c><c r="X9"><f>SUM(B2:B9)</f></c></row></sheet>'
  });
  const {text}=await extractOfficeText('a.xlsx',bytes);assert.match(text,/明细\nB1  hello!\tF1  二/);assert.match(text,/A9  TRUE\tX9  =SUM\(B2:B9\)/);
});
test('OpenDocument paragraphs are bounded, malformed archives rejected',async()=>{
  const bytes=await archive({'content.xml':'<body><p>'+'a'.repeat(270000)+'</p></body>'});
  const {text,truncated}=await extractOfficeText('notes.odt',bytes);assert.equal(text.length,256*1024);assert.ok(truncated);
  await assert.rejects(extractOfficeText('notes.docx',Buffer.from('invalid')));
});
