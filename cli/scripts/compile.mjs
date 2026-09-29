// Builds a single executable with Bun: bun scripts/compile.mjs [--target=bun-linux-x64] [--outfile=bin/bask]
// Ink loads react-devtools-core only when DEV=true; it is stubbed out so the binary needs no extra package.
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const stubDevtools = {
  name: "stub-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default { initialize() {}, connectToDevTools() {} };", loader: "js" }));
  }
};
const result = await Bun.build({
  entrypoints: ["dist/main.js"],
  compile: { outfile: args.outfile ?? "bin/bask", ...(args.target ? { target: args.target } : {}) },
  minify: true,
  plugins: [stubDevtools]
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${args.outfile ?? "bin/bask"}`);
