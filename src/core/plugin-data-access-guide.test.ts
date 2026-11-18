import {expect,test} from 'vitest';
import {resolve} from 'node:path';
import {ProductDocs} from './product-docs';
test('an agent can find and read the bundled data-access guide without models or embeddings',async()=>{
 const docs=new ProductDocs(resolve('docs'));
 const hits=await docs.search('plugin data access user agent guide',10);
 expect(hits.some(h=>h.file==='PLUGIN-DATA-ACCESS.md')).toBe(true);
 const symptom=await docs.search('release-reconcile level 2 protection audit blocked',10);
 expect(symptom.some(h=>h.file==='PLUGIN-DATA-ACCESS.md')).toBe(true);
 const excerpt=await docs.read('PLUGIN-DATA-ACCESS.md',1,120);
 expect(excerpt.content).toContain('Administration');
 expect(excerpt.content).toContain('existing conversation');
 expect(excerpt.content).toContain('last resort');
});
