/**
 * Builds the two halves of the bundle.
 *
 * Host: one ESM file; every `@deepseek-ai/*` import stays external so the
 * plugin shares the Harness's own service instances.
 *
 * Client: the closure-factory artifact the Harness module loader expects,
 * `window.__ModuleLoader__.load({ id, factory(require) })`. React and the
 * Harness platform modules resolve through the injected `require`.
 */
import { build } from 'esbuild'
import { readFile, writeFile, rm } from 'node:fs/promises'

const ID = 'dsh-futurebot'

await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/host/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.cjs.tmp',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis'],
  logLevel: 'warning',
})
const cjs = await readFile('lib/client.cjs.tmp', 'utf8')
await writeFile('lib/client.js', `// ${ID} client bundle
window.__ModuleLoader__.load({
  id: ${JSON.stringify(ID)},
  factory: (require) => {
    const module = { exports: {} };
    (function (require, module, exports) {
${cjs}
    })(require, module, module.exports);
    return module.exports;
  },
});
`)
await rm('lib/client.cjs.tmp')
console.error('built lib/host/index.js and lib/client.js')
