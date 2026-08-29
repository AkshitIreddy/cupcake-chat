import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const packagePlatform = process.env.npm_config_platform ?? process.platform;
const packageArch = process.env.npm_config_arch ?? process.arch;

if (packagePlatform !== 'win32' || packageArch !== 'x64') {
  throw new Error(
    `CUPCAKEAGI 2.0 release-candidate packaging supports Windows x64 only (received ${packagePlatform}-${packageArch}).`,
  );
}

const stagedSidecars = resolve(
  __dirname,
  '../../out/sidecars',
  `${packagePlatform}-${packageArch}`,
  'sidecars',
);

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'CUPCAKEAGI',
    icon: resolve(__dirname, 'public', 'brand', 'cupcake.ico'),
    name: 'CUPCAKEAGI',
    prune: true,
    protocols: [{ name: 'CUPCAKEAGI', schemes: ['cupcake'] }],
    extraResource: existsSync(stagedSidecars) ? [stagedSidecars] : [],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'cupcakeagi',
      authors: 'CUPCAKEAGI contributors',
      description: 'A local, text-first AI workspace with cloud and local model support.',
      setupExe: 'CUPCAKEAGI-Setup.exe',
      setupIcon: resolve(__dirname, 'public', 'brand', 'cupcake.ico'),
    }),
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
