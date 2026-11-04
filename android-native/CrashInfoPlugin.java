package com.reaverslegion.flipscout;

// FlipScout's own native crash capture (free, no accounts, nothing leaves the phone except through your Scan service).
//  - A Java crash: its error and the first lines of where it happened are saved to a small file in the app's private
//    storage just before Android closes the app.
//  - Android 11 and later also keep their own record of why the app last closed (crash, native crash, freeze/ANR...).
// The app reads both the next time it starts and sends them, cleaned of private details, to the Problems list.
import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;

@CapacitorPlugin(name = "CrashInfo")
public class CrashInfoPlugin extends Plugin {
    private static final String FILE = "last-crash.txt";
    private static boolean installed = false;

    // called once when the app starts, before anything else
    public static void install(Context ctx) {
        if (installed) return;
        installed = true;
        final Context app = ctx.getApplicationContext();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    StringWriter sw = new StringWriter();
                    e.printStackTrace(new PrintWriter(sw));
                    String s = System.currentTimeMillis() + "\n" + t.getName() + "\n" + sw.toString();
                    if (s.length() > 4000) s = s.substring(0, 4000);
                    FileOutputStream f = new FileOutputStream(new File(app.getFilesDir(), FILE));
                    f.write(s.getBytes(StandardCharsets.UTF_8));
                    f.close();
                } catch (Throwable ignored) {
                    // recording a crash must never cause another one
                }
                if (previous != null) previous.uncaughtException(t, e);
            }
        });
    }

    @PluginMethod
    public void read(PluginCall call) {
        JSObject out = new JSObject();
        try {
            File f = new File(getContext().getFilesDir(), FILE);
            if (f.exists()) {
                byte[] b = new byte[(int) Math.min(f.length(), 8000)];
                FileInputStream in = new FileInputStream(f);
                int n = in.read(b);
                in.close();
                out.put("javaCrash", new String(b, 0, Math.max(0, n), StandardCharsets.UTF_8));
                f.delete();
            }
        } catch (Throwable ignored) {
        }
        JSArray exits = new JSArray();
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
                List<ApplicationExitInfo> list = am.getHistoricalProcessExitReasons(null, 0, 10);
                for (ApplicationExitInfo e : list) {
                    JSObject o = new JSObject();
                    o.put("reason", e.getReason());
                    o.put("at", e.getTimestamp());
                    o.put("status", e.getStatus());
                    o.put("importance", e.getImportance());
                    o.put("desc", e.getDescription() == null ? "" : e.getDescription());
                    exits.put(o);
                }
            } catch (Throwable ignored) {
            }
        }
        out.put("exits", exits);
        out.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(out);
    }
}
