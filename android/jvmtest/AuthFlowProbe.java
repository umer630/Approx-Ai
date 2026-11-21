import com.approxtech.ai.Api;
import org.json.JSONObject;

/**
 * Runs one authentication step with the APK's own network client (Api.java, the exact class shipped in the APK) and
 * prints the outcome as JSON. Driven by backend/test/apkauth.test.js, which runs the same steps the web app sends and
 * compares what reaches Supabase.   java AuthFlowProbe <base> <signup|verify|resend|login|forgot> <email> [password|code]
 */
public class AuthFlowProbe {
    public static void main(String[] a) throws Exception {
        Api api = new Api(a[0], null);
        String step = a[1], email = a[2], arg = a.length > 3 ? a[3] : "";
        JSONObject out = new JSONObject();
        try {
            JSONObject r;
            switch (step) {
                // Same bodies as MainActivity.showSignup / showVerify / resend / showLogin / showForgot.
                case "signup": r = api.post("/api/auth/signup", new JSONObject().put("email", email).put("password", arg).put("display_name", "Apk Tester")); break;
                case "verify": r = api.post("/api/auth/verify-email", new JSONObject().put("email", email).put("token", arg)); break;
                case "resend": r = api.post("/api/auth/resend-verification", new JSONObject().put("email", email)); break;
                case "login": r = api.post("/api/auth/login", new JSONObject().put("email", email).put("password", arg).put("client", "mobile")); break;
                case "forgot": r = api.post("/api/auth/forgot-password", new JSONObject().put("email", email)); break;
                default: throw new IllegalArgumentException(step);
            }
            out.put("ok", true).put("body", r);
        } catch (Api.ApiException e) {
            out.put("ok", false).put("status", e.status).put("code", e.code).put("message", e.getMessage()).put("retry_after", e.retryAfter);
        }
        System.out.println(out);
    }
}
