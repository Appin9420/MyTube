/**
 * electron-builder afterPack hook.
 *
 * electron-builder's extraResources copier hard-excludes node_modules (its
 * default filter cannot re-include them), so the staged backend would arrive
 * in resources/server without its dependencies. We copy them here instead and
 * verify a known module landed, failing the build otherwise.
 */
const fs = require("fs");
const path = require("path");

const STAGING_NODE_MODULES = path.resolve(
  __dirname,
  "..",
  "build",
  "staging",
  "app",
  "node_modules"
);

module.exports = async function afterPack(context) {
  const dest = path.join(context.appOutDir, "resources", "server", "node_modules");
  if (!fs.existsSync(STAGING_NODE_MODULES)) {
    throw new Error(
      `afterPack: staged node_modules not found at ${STAGING_NODE_MODULES} - run prepare:resources first`
    );
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(STAGING_NODE_MODULES, dest, { recursive: true });

  const packageCount = fs.readdirSync(dest).length;
  if (!fs.existsSync(path.join(dest, "cookie-parser"))) {
    throw new Error(
      `afterPack: node_modules copy verification failed (cookie-parser missing after copying ${packageCount} entries)`
    );
  }
  console.log(
    `[afterPack] backend node_modules -> ${dest} (${packageCount} packages)`
  );
};
