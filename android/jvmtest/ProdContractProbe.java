import com.approxtech.ai.Api;
import com.approxtech.ai.ServerConfig;
import org.json.JSONObject;
// APK API client (Api.java + ServerConfig.java) against the production backend, no account needed:
//   javac -cp json.jar -d out android/src/com/approxtech/ai/{Api,ServerConfig}.java android/jvmtest/ProdContractProbe.java
//   java -cp out:json.jar ProdContractProbe https://approx-ai.vercel.app
public class ProdContractProbe {
    static int fails = 0;
    static void check(boolean ok, String name) { System.out.println((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fails++; }
    public static void main(String[] a) throws Exception {
        String baked = a[0];
        String server = ServerConfig.resolve(baked, "", "")[0];
        check(server.equals("https://approx-ai.vercel.app"), "APK server resolution → " + server);
        Api api = new Api(server, null);
        JSONObject v = api.get("/api/version");
        check("Approx AI".equals(v.optString("product")), "production /api/version reachable over HTTPS");
        check("1.8".equals(v.getJSONObject("versions").optString("api_contract")), "API contract 1.8 (APK min versionCode " + v.getJSONObject("versions").optInt("min_apk_version_code") + ")");
        check(v.getJSONObject("models").has("nick-4.8"), "model metadata discovered from the server: nick-4.8 lifecycle=" + v.getJSONObject("models").getJSONObject("nick-4.8").optString("lifecycle_state"));
        try { api.get("/api/models"); check(false, "/api/models requires a session"); } catch (Api.ApiException e) { check(e.status == 401, "/api/models without a session → 401"); }
        try { api.post("/api/auth/login", new JSONObject().put("email", "nobody-probe@example.com").put("password", "wrong-Passw0rd-1").put("client", "mobile")); check(false, "bad login rejected"); }
        catch (Api.ApiException e) { check(e.status == 401 && "unauthorized".equals(e.code), "login against production Supabase: wrong credentials → 401 unauthorized"); }
        try { api.get("/api/admin/overview"); check(false, "admin API refuses"); } catch (Api.ApiException e) { check(e.status == 401, "admin API refuses the APK client → 401"); }
        System.exit(fails);
    }
}
