import { build } from "esbuild";
import { readdirSync, statSync, mkdirSync, cpSync, rmSync, existsSync } from "fs";
import { join, relative, basename } from "path";

const DIST_DIR = "dist";
const EXT_SRC_DIR = join("src", "extension");
const EXT_DIST_DIR = "extension";

function getEntryPoints(dir) {
  const entries = [];
  for (const item of readdirSync(dir)) {
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...getEntryPoints(fullPath));
    } else if (item.endsWith(".js") && !item.endsWith(".min.js") && !item.endsWith(".map")) {
      entries.push(fullPath);
    }
  }
  return entries;
}

async function bundleServer() {
  const entryPoints = getEntryPoints(DIST_DIR);
  console.log(`Bundling ${entryPoints.length} server files...`);

  for (const entry of entryPoints) {
    const outFile = entry.replace(/\.js$/, ".min.js");
    const relPath = relative(process.cwd(), entry);
    console.log(`  ${relPath} -> ${relative(process.cwd(), outFile)}`);

    await build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      treeShaking: true,
      platform: "node",
      target: "node22",
      format: "esm",
      outfile: outFile,
      sourcemap: false,
      legalComments: "none",
      // Never bundle dependencies: they are installed next to the package and
      // version-locked by npm-shrinkwrap.json.
      packages: "external",
    });
  }

  // Delete the original unminified .js files to save space in the npm package
  // We do this after all files are bundled so esbuild can resolve cross-file imports during the build
  for (const entry of entryPoints) {
    try {
      rmSync(entry);
    } catch (e) {
      // ignore
    }
  }
}

async function bundleExtension() {
  console.log(`Bundling extension files from ${EXT_SRC_DIR} to ${EXT_DIST_DIR}...`);
  if (!existsSync(EXT_SRC_DIR)) {
    console.log(`  Skipping: ${EXT_SRC_DIR} not found.`);
    return;
  }

  // Clean and recreate extension output dir
  if (existsSync(EXT_DIST_DIR)) {
    rmSync(EXT_DIST_DIR, { recursive: true, force: true });
  }
  mkdirSync(EXT_DIST_DIR, { recursive: true });

  const items = readdirSync(EXT_SRC_DIR);
  for (const item of items) {
    const srcPath = join(EXT_SRC_DIR, item);
    const distPath = join(EXT_DIST_DIR, item);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      console.log(`  Copying directory ${item}/...`);
      cpSync(srcPath, distPath, { recursive: true });
    } else if (item.endsWith(".js") && item !== "tailwind.config.js") {
      console.log(`  Minifying ${item}...`);
      await build({
        entryPoints: [srcPath],
        bundle: false,
        minify: true,
        target: "es2022",
        outfile: distPath,
        sourcemap: false,
        legalComments: "none",
      });
    } else {
      console.log(`  Copying ${item}...`);
      cpSync(srcPath, distPath);
    }
  }
}

async function bundle() {
  await bundleServer();
  await bundleExtension();
  console.log("Done.");
}

bundle().catch((err) => {
  console.error("Bundle failed:", err);
  process.exit(1);
});

