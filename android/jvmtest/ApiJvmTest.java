import com.approxtech.ai.Api;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Exercises the Android app's network layer (Api.java — the exact class shipped in the APK)
 * on a JVM against a running Approx backend. Usage: java ApiJvmTest <baseUrl> <email> <password>
 * The account must already exist and be verified.
 */
public class ApiJvmTest {
    static int fails = 0;
    static void check(boolean ok, String name) { System.out.println((ok ? "PASS " : "FAIL ") + name); if (!ok) fails++; }

    public static void main(String[] a) throws Exception {
        try { Api.normalizeServer("http://insecure.example"); check(false, "https enforced"); } catch (Api.ApiException e) { check("insecure_url".equals(e.code), "https enforced for server URL"); }
        Api api = new Api(a[0], null);
        check("Approx AI".equals(api.get("/api/version").optString("product")), "version probe");
        try { api.post("/api/auth/login", new JSONObject().put("email", a[1]).put("password", "wrong-pass-123").put("client", "mobile")); check(false, "bad login rejected"); }
        catch (Api.ApiException e) { check(e.status == 401, "bad login rejected (401)"); }
        JSONObject login = api.post("/api/auth/login", new JSONObject().put("email", a[1]).put("password", a[2]).put("client", "mobile"));
        api.setToken(login.getString("token"));
        check(login.getString("token").length() > 20, "mobile login returns bearer token");
        JSONArray models = api.get("/api/models").getJSONArray("models");
        check(models.length() == 5, "models listed");
        String chat = api.post("/api/chats", new JSONObject().put("model", "auto").put("mode", "high")).getJSONObject("chat").getString("id");
        final StringBuilder acc = new StringBuilder();
        final boolean[] done = {false};
        final String[] routed = {null};
        api.stream("/api/chats/" + chat + "/messages", new JSONObject().put("content", "Assalam o alaikum! Pakistan ka darul hakumat kya hai?").put("model", "auto").put("mode", "high").put("attachments", new JSONArray()), new Api.StreamHandler() {
            public void onRoute(JSONObject r) { routed[0] = r.optString("model_id") + "/" + r.optString("mode"); }
            public void onDelta(String t) { acc.append(t); }
            public void onDone(JSONObject d) { done[0] = true; }
            public void onError(String c, String m) { System.out.println("stream error " + c + " " + m); }
        });
        check(done[0] && acc.length() > 0, "SSE streaming chat (" + acc.length() + " chars, routed " + routed[0] + ")");
        check(routed[0] != null && routed[0].endsWith("/high"), "High mode honoured");
        JSONObject up = api.upload("notes.txt", "hello from android".getBytes("UTF-8"));
        check("clean".equals(up.getJSONObject("file").getString("scan_status")), "file upload");
        try { api.upload("x.exe", "MZ".getBytes()); check(false, "exe blocked"); } catch (Api.ApiException e) { check(e.status == 415, "executable upload blocked"); }
        JSONArray hist = api.get("/api/chats?view=active&q=" + Api.enc("darul")).getJSONArray("chats");
        check(hist.length() == 1, "history search");
        api.patch("/api/chats/" + chat, new JSONObject().put("title", "Renamed on Android"));
        check("Renamed on Android".equals(api.get("/api/chats/" + chat).getJSONObject("chat").getString("title")), "rename chat");
        api.post("/api/memory", new JSONObject().put("content", "I use the Android app"));
        check(api.get("/api/memory").getJSONArray("memories").length() >= 1, "memory add/list");
        check(api.get("/api/usage").getJSONObject("window").getInt("limit") == 100, "usage/quota");
        try { api.post("/api/chats", new JSONObject().put("model", "fab-100x")); check(false, "FAB locked"); } catch (Api.ApiException e) { check(e.status == 403, "FAB locked for normal user"); }
        api.post("/api/auth/logout", new JSONObject());
        try { api.get("/api/auth/me"); check(false, "logout"); } catch (Api.ApiException e) { check(e.status == 401, "logout revokes token"); }
        System.out.println(fails == 0 ? "ALL PASS" : fails + " FAILED");
        System.exit(fails == 0 ? 0 : 1);
    }
}
