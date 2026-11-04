// Build step: adds FlipScout's crash capture (CrashInfoPlugin.java) to the Android project that "npx cap add android"
// just made, and registers it in MainActivity. Stops the build if MainActivity isn't the expected shape, rather than
// silently building an app without crash capture.
import fs from "node:fs";
import path from "node:path";
// find MainActivity.java wherever this app's package name put it (the phone test build has its own package name)
const find = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(path.join(d, e.name)) : e.name === "MainActivity.java" ? [path.join(d, e.name)] : []));
const found = find("android/app/src/main/java");
if (found.length !== 1) { console.error("expected one MainActivity.java, found: " + found.join(", ")); process.exit(1); }
const main = found[0], dir = path.dirname(main), src = fs.readFileSync(main, "utf8"), pkg = (src.match(/^package ([\w.]+);/m) || [])[1];
if (!pkg) { console.error("no package line in MainActivity.java"); process.exit(1); }
const from = /public class MainActivity extends BridgeActivity\s*\{\s*\}/;
if (!from.test(src)) { console.error("MainActivity.java isn't the expected empty class:\n" + src); process.exit(1); }
fs.writeFileSync(`${dir}/CrashInfoPlugin.java`, fs.readFileSync(new URL("./CrashInfoPlugin.java", import.meta.url), "utf8").replace(/^package [\w.]+;/m, `package ${pkg};`));
fs.writeFileSync(main, src.replace(from, `public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        CrashInfoPlugin.install(this);
        registerPlugin(CrashInfoPlugin.class);
        super.onCreate(savedInstanceState);
    }
}`));
console.log("crash capture added:\n" + fs.readFileSync(main, "utf8"));
