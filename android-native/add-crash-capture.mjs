// Build step: adds FlipScout's crash capture (CrashInfoPlugin.java) to the Android project that "npx cap add android"
// just made, and registers it in MainActivity. Stops the build if MainActivity isn't the expected shape, rather than
// silently building an app without crash capture.
import fs from "node:fs";
const dir = "android/app/src/main/java/com/reaverslegion/flipscout", main = `${dir}/MainActivity.java`;
const src = fs.readFileSync(main, "utf8");
const from = /public class MainActivity extends BridgeActivity\s*\{\s*\}/;
if (!from.test(src)) { console.error("MainActivity.java isn't the expected empty class:\n" + src); process.exit(1); }
fs.copyFileSync(new URL("./CrashInfoPlugin.java", import.meta.url), `${dir}/CrashInfoPlugin.java`);
fs.writeFileSync(main, src.replace(from, `public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        CrashInfoPlugin.install(this);
        registerPlugin(CrashInfoPlugin.class);
        super.onCreate(savedInstanceState);
    }
}`));
console.log("crash capture added:\n" + fs.readFileSync(main, "utf8"));
