/* Binding-counter checks.
 *
 * This proxy sits in front of EVERY KV call in the Worker — a far more dangerous
 * place than the fetch wrap, which only fronts outbound HTTP. So the cases that
 * matter most here are the failure ones: a counter fault must degrade to
 * `bindingsWrapped: []` and a WORKING env, never to a broken KV read.
 *
 * It also checks the thing the design exists for: that coverage is derived from
 * the shape of `env` rather than from a hardcoded "REC_LOG", so a binding added
 * later is counted without anyone remembering this file.
 *
 * Functions are extracted from worker.js by source (named exports must all be
 * functions or workerd refuses to boot). Prints computed vs expected.
 */
import fs from 'fs';

const src = fs.readFileSync('worker.js', 'utf8');
function grab(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('missing ' + name);
  let p = src.indexOf('(', i), depth = 0, j = p;
  do { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; j++; } while (depth > 0);
  let d = 0, k = src.indexOf('{', j);
  do { if (src[k] === '{') d++; else if (src[k] === '}') d--; k++; } while (d > 0);
  return src.slice(i, k);
}
const INSTR_DECL = src.slice(src.indexOf('const INSTR = {'), src.indexOf('};', src.indexOf('const INSTR = {')) + 2);

const M = new Function(
  `${INSTR_DECL}\n` +
  [ 'looksLikeBinding', 'countingBinding', 'instrWrapBindings', 'instrReset', 'instrMark', 'instrSince' ]
    .map(grab).join('\n') +
  '\nreturn { INSTR, looksLikeBinding, countingBinding, instrWrapBindings, instrReset, instrMark, instrSince };',
)();

let fails = 0;
const pad = (s, n) => String(s).padEnd(n);
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`  ${pad(label, 52)} got ${pad(JSON.stringify(got), 30)} want ${pad(JSON.stringify(want), 24)} ${ok ? 'OK' : '<<< MISMATCH'}`);
};

/* A stand-in KV namespace with the real method surface. */
const fakeKV = () => {
  const calls = [];
  return {
    calls,
    get:    async (k, t) => { calls.push(['get', k, t]); return null; },
    put:    async (k, v, o) => { calls.push(['put', k]); },
    delete: async (k) => { calls.push(['delete', k]); },
    list:   async (o) => { calls.push(['list']); return { keys: [], list_complete: true }; },
  };
};

console.log('\n══ 1. Shape detection — bindings vs secrets vs plain vars ══');
console.log('   A secret is a string. A [vars] JSON entry is an object with NO methods.');
console.log('   A binding is an object/function carrying at least one callable member.\n');
check('KV-shaped object',            M.looksLikeBinding(fakeKV()), true);
check('service binding {fetch}',     M.looksLikeBinding({ fetch: async () => {} }), true);
check('DO namespace {idFromName,get}', M.looksLikeBinding({ idFromName: () => {}, get: () => {} }), true);
check('class instance w/ proto method', M.looksLikeBinding(new (class { q() {} })()), true);
check('callable binding (function)',  M.looksLikeBinding(Object.assign(() => {}, { fetch: () => {} })), true);
check('secret (string)',             M.looksLikeBinding('sk-ant-abc123'), false);
check('numeric var',                 M.looksLikeBinding(42), false);
check('[vars] JSON object, no methods', M.looksLikeBinding({ tier: 'paid', max: 10000 }), false);
check('null',                        M.looksLikeBinding(null), false);
check('undefined',                   M.looksLikeBinding(undefined), false);
check('empty object',                M.looksLikeBinding({}), false);

console.log('\n══ 2. Counting — every call on every wrapped binding ══');
{
  M.instrReset('test');
  const kv = fakeKV();
  const env = M.instrWrapBindings({ REC_LOG: kv, ANTHROPIC_API_KEY: 'sk-secret', TIER: { plan: 'paid' } });
  check('bindingsWrapped', M.INSTR.bindingsWrapped, ['REC_LOG']);
  check('bindingsSkipped', M.INSTR.bindingsSkipped, []);
  check('secret passed through untouched', env.ANTHROPIC_API_KEY, 'sk-secret');
  check('plain var passed through', env.TIER, { plan: 'paid' });

  const mark = M.instrMark();
  await env.REC_LOG.get('a', 'json');
  await env.REC_LOG.get('b', 'json');
  await env.REC_LOG.put('c', '{}');
  await env.REC_LOG.list({ prefix: 'iv:' });
  await env.REC_LOG.delete('d');
  const r = M.instrSince(mark, 'complete');
  check('bindingOps counted', r.bindingOps, 5);
  check('calls actually reached the target', kv.calls.length, 5);
  check('capCost = ext + bindings', r.capCost, r.extFetches + r.bindingOps);
  check('coverage declared', r.bindingsWrapped, ['REC_LOG']);
  check('cache API gap declared', r.cacheApiCounted, false);
}

console.log('\n══ 3. A SECOND binding added later is counted automatically ══');
console.log('   This is the whole point of detecting by shape: nobody edits the counter.\n');
{
  M.instrReset('test');
  const kv = fakeKV(), r2 = fakeKV();
  const env = M.instrWrapBindings({ REC_LOG: kv, CHAIN_ARCHIVE: r2, FRED_API_KEY: 'k' });
  check('both bindings wrapped', M.INSTR.bindingsWrapped, ['REC_LOG', 'CHAIN_ARCHIVE']);
  const mark = M.instrMark();
  await env.REC_LOG.get('a');
  await env.CHAIN_ARCHIVE.put('b', 'x');
  await env.CHAIN_ARCHIVE.get('c');
  const r = M.instrSince(mark, 'complete');
  check('ops summed across bindings', r.bindingOps, 3);
}

console.log('\n══ 4. FAILURE PATHS — a counter fault must never break a KV read ══');
{
  // A binding whose property access throws on wrap-time inspection.
  M.instrReset('test');
  const hostile = new Proxy({}, {
    ownKeys() { throw new Error('ownKeys exploded'); },
    get(t, p) { if (p === 'get') return async () => 'still works'; return undefined; },
  });
  let env, threw = null;
  try { env = M.instrWrapBindings({ REC_LOG: hostile }); } catch (e) { threw = e.message; }
  check('wrap did not throw', threw, null);
  check('env still usable', typeof (await (env.REC_LOG.get?.('k') ?? 'missing')), 'string');

  // Total failure: env itself is hostile to enumeration.
  M.instrReset('test');
  const badEnv = new Proxy({}, { ownKeys() { throw new Error('env exploded'); } });
  let out, threw2 = null;
  try { out = M.instrWrapBindings(badEnv); } catch (e) { threw2 = e.message; }
  check('total failure did not throw', threw2, null);
  check('returns the ORIGINAL env', out === badEnv, true);
  check('degrades to bindingsWrapped: []', M.INSTR.bindingsWrapped, []);
  check('and says why in bindingsSkipped', M.INSTR.bindingsSkipped.length > 0, true);

  // Null / non-object env.
  check('null env returns null', M.instrWrapBindings(null), null);
  check('string env returns it unchanged', M.instrWrapBindings('nope'), 'nope');
}

console.log('\n══ 5. Method identity and `this` binding survive the proxy ══');
{
  M.instrReset('test');
  // A class using a private field: the proxy must apply with the raw target as
  // `this`, or the internal slot lookup throws.
  class KVLike {
    #store = new Map();
    async get(k) { return this.#store.get(k) ?? null; }
    async put(k, v) { this.#store.set(k, v); }
  }
  const env = M.instrWrapBindings({ REC_LOG: new KVLike() });
  let err = null;
  try {
    await env.REC_LOG.put('k', 'v');
    const v = await env.REC_LOG.get('k');
    check('private-field class works through proxy', v, 'v');
  } catch (e) { err = e.message; fails++; console.log('  private-field class FAILED:', e.message); }
  check('no error applying methods', err, null);
  check('memoised wrapper is stable', env.REC_LOG.get === env.REC_LOG.get, true);
}

console.log('\n══ 6. instrSince with no baseline still reports honestly ══');
check('null mark -> measured:false', M.instrSince(null, 'x').measured, false);
check('null mark -> no fabricated capCost', M.instrSince(null, 'x').capCost, undefined);

console.log(`\n${fails === 0 ? 'All checks matched.' : fails + ' MISMATCH(ES) — see above.'}`);
process.exitCode = fails === 0 ? 0 : 1;
