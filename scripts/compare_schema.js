import fs from 'node:fs';

const contract = fs.readFileSync('CONTRACT_v2.md', 'utf8');
const schema = fs.readFileSync('db/schema_v2.sql', 'utf8');

// Extract SQL block from contract (between ```sql and ```)
const m = contract.match(/```sql\n([\s\S]+?)\n```/);
if (!m) { console.log('ERROR: could not find sql block in CONTRACT'); process.exit(1); }

// Normalize line endings
const contractSql = m[1].replace(/\r\n/g, '\n').trimEnd();
const schemaSql = schema.replace(/\r\n/g, '\n').trimEnd();

if (contractSql === schemaSql) {
  console.log('MATCH: schema_v2.sql matches CONTRACT §2 verbatim');
} else {
  const cl = contractSql.split('\n');
  const sl = schemaSql.split('\n');
  const maxLines = Math.max(cl.length, sl.length);
  let diffCount = 0;
  for (let i = 0; i < maxLines; i++) {
    const c = cl[i] ?? '<MISSING>';
    const s = sl[i] ?? '<MISSING>';
    if (c !== s) {
      diffCount++;
      console.log(`Line ${i+1} DIFF:`);
      console.log(`  CONTRACT: ${JSON.stringify(c)}`);
      console.log(`  SCHEMA:   ${JSON.stringify(s)}`);
      if (diffCount >= 20) { console.log('...more diffs truncated'); break; }
    }
  }
  console.log(`Total diff lines shown: ${diffCount}. CONTRACT lines: ${cl.length}, SCHEMA lines: ${sl.length}`);
}
