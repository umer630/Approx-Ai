import com.approxtech.ai.Api;
import com.approxtech.ai.Greeting;
import com.approxtech.ai.ServerConfig;

/**
 * Startup configuration + greeting, using the exact classes shipped in the APK.
 * Usage: java StartupJvmTest <default_server_url read from the built APK>
 */
public class StartupJvmTest {
    static int fails = 0;
    static void check(boolean ok, String n) { System.out.println((ok ? "PASS " : "FAIL ") + n); if (!ok) fails++; }
    static void eq(String a, String b, String n) { check(a.equals(b), n + (a.equals(b) ? "" : "  — got '" + a + "' want '" + b + "'")); }

    public static void main(String[] a) throws Exception {
        String baked = a[0];
        eq(baked, "https://approx-ai.vercel.app", "APK bakes the production origin");
        String[] r = ServerConfig.resolve(baked, "", "");
        eq(r[0], "https://approx-ai.vercel.app", "fresh install → production server, no URL screen");
        eq(r[1], "0", "fresh install keeps nothing to discard");
        r = ServerConfig.resolve(baked, "https://old-server.example", "");
        eq(r[0], baked, "update over an old build's saved server → production");
        eq(r[1], "1", "stale override (and its session) discarded");
        r = ServerConfig.resolve(baked, "https://staging.approx.example", baked);
        eq(r[0], "https://staging.approx.example", "admin override saved on this build is kept");
        r = ServerConfig.resolve(baked, "https://approx-ai.vercel.app/#/login", baked);
        eq(r[0], "https://approx-ai.vercel.app", "a web route (/#/login) never becomes the API base");
        eq(Api.normalizeServer("https://Approx-AI.vercel.app/#/login"), "https://approx-ai.vercel.app", "normalizeServer → origin only");
        r = ServerConfig.resolve("", "", "");
        eq(r[0], "", "unconfigured build has no server (build.sh refuses to produce one)");

        String[] g = Greeting.of("Umer Khan", "u@x.com", 10, false, 0);
        eq(g[0], "Good morning, Umer", "greeting uses first name");
        eq(g[1], "Welcome to Approx AI. What would you like to do?", "first-visit subtitle");
        eq(Greeting.of("Umer", "", 14, true, 0)[0], "Good afternoon, Umer", "afternoon greeting");
        eq(Greeting.of("Umer", "", 18, true, 0)[0], "Good evening, Umer", "evening greeting");
        eq(Greeting.of("Umer", "", 22, true, 0)[0], "Good night, Umer", "night greeting");
        eq(Greeting.of("Umer", "", 2, true, 0)[0], "Night owl, Umer?", "late-night greeting");
        eq(Greeting.of("Umer", "", 9, true, 0)[1], "How are you today, Umer?", "personal subtitle");
        eq(Greeting.of("", "uq866108@gmail.com", 23, true, 0)[0], "Good night", "random handle is not used as a name");
        eq(Greeting.of("", "umer.khan@gmail.com", 8, true, 1)[0], "Good morning, Umer", "name-like email local part");
        System.out.println(fails == 0 ? "ALL PASS" : fails + " FAILED");
        System.exit(fails == 0 ? 0 : 1);
    }
}
