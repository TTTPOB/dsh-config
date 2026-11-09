import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import type { UserConfig } from 'vite';

/** Build one standalone Node ESM plugin without clearing sibling deployable modules. */
export function pluginConfig(id: string): UserConfig {
  return {
    publicDir: false,
    build: {
      target: 'node24',
      outDir: fileURLToPath(new URL('../../plugins/', import.meta.url)),
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('../' + id + '/src/index.ts', import.meta.url)),
        formats: ['es'],
        fileName: () => id + '.mjs',
      },
      rolldownOptions: {
        external: [...builtinModules, ...builtinModules.map((name) => 'node:' + name)],
        output: {
          codeSplitting: false,
          banner:
            '// Generated from plugins-src/' + id + '; run pnpm build:' + id + '. Do not edit directly.',
        },
      },
    },
  };
}
