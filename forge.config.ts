import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

// Enable signing on Windows only if WIN_CERT_SHA1 is provided
const winSignParams = process.env.WIN_CERT_SHA1
  ? `/sha1 ${process.env.WIN_CERT_SHA1} /tr http://timestamp.digicert.com /td SHA256 /fd SHA256`
  : undefined; // unsigned by default in forks

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "dyad",
  },
  makers: [
    new MakerSquirrel({ signWithParams: winSignParams }),
    new MakerZIP({}, ["darwin", "linux"]),
    new MakerDeb({}),
    new MakerRpm({}),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.mts" },
        { entry: "src/preload.ts", config: "vite.preload.config.mts" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.mts" }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
    }),
  ],
};

export default config;
